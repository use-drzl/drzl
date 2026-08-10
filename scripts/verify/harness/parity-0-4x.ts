/**
 * Differential parity for DRZL's validator generators on drizzle-orm 0.4x.
 *
 * Same method as `src/parity.ts` in the v1 tree and the same pool of values, imported from the
 * same file: build a schema for every column of every table in three dialects and all three
 * modes, with DRZL and with the official first-party module, then push the pool through both and
 * compare verdicts. Reading the emitted source cannot do this, because a schema that validates
 * and one that merely parses look identical as text.
 *
 * The ledger is the part that makes this runnable rather than permanently red. Two maps:
 *
 *   ALLOWED  DRZL and the official 0.4x module really do differ here, deliberately.
 *   DEFECTS  DRZL is wrong on 0.4x, whichever way the difference runs. Filed rather than fixed,
 *            and reported every run. Not "looser than official": ALLOWED entries are looser and
 *            right too, because the database says so, and every run counts how many rather than
 *            leaving a number here to go stale. Two copies of this sentence carried the same
 *            number; the round that corrected it landed on the one over the map itself and left
 *            this one behind, which is what a number in prose costs.
 *
 * Both are asserted exactly and in both directions. A difference in neither map fails the stage; an
 * entry that suppresses nothing fails it; and an entry whose libraries, modes, pairing count or
 * exact divergence no longer match what was measured fails it with the observed signature printed.
 * That last direction is the one that matters. A list checked only for additions turns into a
 * record of things that used to be wrong, and a fix then regresses with the gate still green.
 *
 * `divergence` is what makes an entry pin a specific difference rather than a shape. Three
 * sabotages walked through the shape-only version, and all three are named now, each verified by
 * running the stage against the edited output:
 *
 *   c_char capped at 400 code points instead of 4
 *   c_char's length check deleted, so a char(4) schema takes a 70,000 character string
 *   m_tinytext tightened from 255 bytes to 3, so it refuses 'hello' into a TINYTEXT column
 *
 * None of them changes the libraries, the modes, the pairing count or which way the disagreement
 * runs. All of them change which probes differ, which is the only thing that cannot be preserved
 * by a change to the column's behaviour.
 *
 * `c_char` was the example this docstring used to call an exception. It is not one, and the
 * numbers are worth keeping because they show what a partial fix looks like. Recomputed against
 * the real official field: it differs on 7 pool values today, on 5 if DRZL counted UTF-16 units,
 * and on none if DRZL demanded exactly 4 code points. Every one of those is a different signature,
 * so all three states are distinguishable now, where before only the third was.
 *
 * A ragged defect, one that reached zod on select and valibot on insert alone, is declarable:
 * `divergence` keys are `<modes>/<libraries>` and can name a single pairing. The pairing count
 * would still have to be stated, and a sentence here used to say such a defect would have to be
 * split into two entries, which the key format does not allow.
 */
import { readFileSync } from 'node:fs';
import { constants } from 'node:buffer';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { SchemaAnalyzer } from '@drzl/analyzer';
import {
  POOL,
  LIBS,
  probe,
  askPostgres,
  askPresence,
  type DbProbe,
  type Lib,
  type Verdict,
} from './src/pool.js';

import {
  createSelectSchema as zSelect,
  createInsertSchema as zInsert,
  createUpdateSchema as zUpdate,
} from 'drizzle-zod';
import {
  createSelectSchema as vSelect,
  createInsertSchema as vInsert,
  createUpdateSchema as vUpdate,
} from 'drizzle-valibot';
import {
  createSelectSchema as aSelect,
  createInsertSchema as aInsert,
  createUpdateSchema as aUpdate,
} from 'drizzle-arktype';
import {
  createSelectSchema as tSelect,
  createInsertSchema as tInsert,
  createUpdateSchema as tUpdate,
} from 'drizzle-typebox';

import { matrix as pgTable, nullable as pgNullable } from './src/matrix.js';
import { matrix as myTable, nullable as myNullable } from './src/matrix-mysql.js';
import { matrix as sqTable, nullable as sqNullable } from './src/matrix-sqlite.js';

const OFFICIAL: Record<string, Record<string, (t: any) => any>> = {
  zod: { select: zSelect, insert: zInsert, update: zUpdate },
  valibot: { select: vSelect, insert: vInsert, update: vUpdate },
  arktype: { select: aSelect, insert: aInsert, update: aUpdate },
  typebox: { select: tSelect, insert: tInsert, update: tUpdate },
};

type Entry = {
  /** The libraries this difference shows up in, asserted exactly against what was measured. */
  libs: string[];
  /** The modes it shows up in, asserted the same way. */
  modes: string[];
  /**
   * The exact divergence this entry covers, keyed `<modes>/<libraries>` with `*` for all of them.
   *
   * A signature is `L: <labels DRZL accepts and official refuses> | T: <the other way>`, in pool
   * order, and it has to match what the run measured character for character.
   * `every probe official rejects (N of them), and official accepts only: <labels>` states the
   * same set from the other end, for the columns DRZL accepts the whole pool of: the divergence is
   * exactly official's rejections, N is how many those are, and the labels are the complement,
   * which is a handful where the list they replace is nearly the whole pool. Naming the complement
   * is what makes it a set. The count on its own was a shape, measured: with `c_vector` changed
   * from `vector({ dimensions: 3 })` to `dimensions: 2`, official refuses `[1,2,3]` and accepts
   * `[1,2]`, which is the opposite behaviour at an unchanged count, and the stage was green.
   *
   * This replaced a `direction` field, which named only which way the disagreement ran. That
   * closed a reversal and nothing else, and three sabotages walked through it: capping `c_char` at
   * 400 code points instead of 4, deleting its length check entirely so a `char(4)` schema takes a
   * 70,000 character string, and tightening `m_tinytext` from 255 bytes to 3. All three keep the
   * libraries, the modes, the pairing count and the direction, and all three are named now,
   * because all three change which probes differ.
   *
   * It is brittle against a pool change, deliberately. Adding a value that any waived column
   * treats differently from official has to re-open that waiver, because the alternative is a
   * waiver silently covering a divergence nobody has looked at, which is how two filed `maxLength`
   * fields spent a round under a green line.
   */
  divergence: Record<string, string>;
  /** What DRZL emits on 0.4x. */
  drzl: string;
  /** What the official 0.4x module emits for the same column. */
  official: string;
  /** Which filed defect this is, or why it is not one. */
  filed: string;
};

/**
 * A signature for a column DRZL accepts every probe of: official's rejection count, plus the exact
 * set official accepts instead. The columns in that state are the ones the class-name path cannot
 * name at all, and the alternative is writing out nearly the whole pool once per pairing group.
 * How many they are is printed by the run, off the ledgers themselves, rather than written here.
 *
 * Naming what official accepts names the divergence exactly, from the other end. DRZL accepted
 * every compared probe, so the probes that differ are exactly the ones official rejected, and that
 * is every compared probe except the ones listed here: a handful of labels instead of nearly all
 * of them.
 *
 * Both halves are here because each closed a hole the other left open, and both holes were live.
 *
 *   the count       the phrase alone pinned DRZL's side only. "DRZL accepts everything" fails the
 *                   moment DRZL stops accepting everything, but official was not mentioned, so
 *                   official narrowing its rejections to two left the signature unmoved.
 *   the complement  the count pinned how many, not which. Measured: `c_vector` changed from
 *                   `vector({ dimensions: 3 })` to `dimensions: 2` in src/matrix.ts makes official
 *                   accept `[1,2]` and refuse `[1,2,3]`, the opposite behaviour, at an unchanged
 *                   count on all 12 pairings. The stage exited 0 and went on printing "official
 *                   emits an array of exactly 3 numbers". With the complement declared the same
 *                   edit exits 1 on all 12 pairings.
 *
 * Why the numbers are not uniform over the 72 pairings, measured on this run rather than reasoned,
 * and now visible in the declarations themselves rather than only described here:
 *
 *   update on zod, valibot, arktype   one fewer rejection, always `undefined`. Official's update
 *                                     schema marks the field optional, and in those three the
 *                                     extracted field takes `undefined` on its own.
 *   update on typebox                 no such move. TypeBox holds optionality as a modifier the
 *                                     parent object consults, and this harness compares
 *                                     `s.properties[k]`, where it is inert:
 *                                     `Value.Check(prop, undefined)` is false with
 *                                     `Symbol(TypeBox.Optional)` present on the property, and
 *                                     deleting that symbol changes no pool verdict at all.
 *   valibot on c_geometry             one fewer in every mode: official builds a `v.tuple`, which
 *                                     ignores extra items, so `[1,2,3]` and `[1,2,3,4]` both go
 *                                     into a 2-tuple and `[1,2,3]` is accepted alongside `[1,2]`.
 *   typebox on c_bit                  a count of its own in every mode, and not because it takes
 *                                     anything the other three refuse. Official's TypeBox schema
 *                                     throws on `null` and `undefined` for that column, so those
 *                                     two probes are not compared at all: they go to the THREW
 *                                     ledger and are arbitrated against a real Postgres. An
 *                                     earlier version of this note said "TypeBox refuses two fewer
 *                                     probes than the rest on `c_bit`", which reads as a rejection
 *                                     it never made and was wrong about update as well. The
 *                                     declarations below are the counts; no number is repeated
 *                                     here, because the one that was went stale twice.
 */
const allProbes = (n: number, accepted: string[]) =>
  `every probe official rejects (${n} of them), and official accepts only: ` +
  (accepted.length ? accepted.join(', ') : 'nothing in the pool');

/**
 * Does a declaration key such as `select,insert/zod,typebox` cover the pairing `select/zod`?
 * `*` on either side means all of them. Kept deliberately dumb: a declaration that covers no
 * pairing, or two that cover the same one, both fail rather than being resolved by precedence.
 */
const pairingMatches = (decl: string, pairing: string) => {
  const [dModes, dLibs] = decl.split('/');
  const [mode, lib] = pairing.split('/');
  const covers = (spec: string, x: string) => spec === '*' || spec.split(',').includes(x);
  return covers(dModes, mode) && covers(dLibs, lib);
};

const LIB_NAMES = ['zod', 'valibot', 'arktype', 'typebox'];
const MODE_NAMES = ['select', 'insert', 'update'];
// Insert and update. A divergence that only exists on write is a different claim from one that
// exists on read, and coerceDates is the reason the distinction is load-bearing here.
const WRITE = ['insert', 'update'];

/**
 * Divergences from the official 0.4x module that are deliberate and reasoned.
 *
 * Every one of these also holds against the v1 module, and the v1 pass carries the same reasoning
 * in its own ALLOWED map, except where noted on `c_char`.
 */
const ALLOWED: Record<string, Entry> = {
  // A temporal column carried as text refuses a string with nothing in it but whitespace, and the
  // official validators take one. The v1 copy of this entry carries the measurement: through
  // PGlite, Postgres refuses `''` and `' '` for every temporal type and accepts a valid value with
  // surrounding whitespace, so the check refuses exactly the set the server refuses. The marker is
  // set on both majors on purpose, which is why it shows up in both ledgers.
  'pg/c_date_s': { libs: LIB_NAMES, modes: MODE_NAMES, divergence: { '*/*': `L:  | T: ""` }, drzl: 'refuses a blank string, which no temporal type accepts', official: 'accepts any string at all', filed: 'not a defect: the database refuses the value' },
  'pg/c_ts_s': { libs: LIB_NAMES, modes: MODE_NAMES, divergence: { '*/*': `L:  | T: ""` }, drzl: 'as pg/c_date_s', official: 'as pg/c_date_s', filed: 'as pg/c_date_s' },
  'pg/c_time': { libs: LIB_NAMES, modes: MODE_NAMES, divergence: { '*/*': `L:  | T: ""` }, drzl: 'as pg/c_date_s', official: 'as pg/c_date_s', filed: 'as pg/c_date_s' },
  'pg/c_interval': { libs: LIB_NAMES, modes: MODE_NAMES, divergence: { '*/*': `L:  | T: ""` }, drzl: 'as pg/c_date_s', official: 'as pg/c_date_s', filed: 'as pg/c_date_s' },
  // MySQL's `time` is deliberately not here and not marked: it accepts a blank and stores 00:00:00.
  'mysql/m_date_s': { libs: LIB_NAMES, modes: MODE_NAMES, divergence: { '*/*': `L:  | T: ""` }, drzl: 'as pg/c_date_s, measured on MySQL 8.4.11', official: 'as pg/c_date_s', filed: 'as pg/c_date_s' },
  // ---- five columns that stopped being defects when the class-name path learned their names ----
  // Each of these was `unknown, which accepts every value in the pool`. `SQLiteBlobBuffer` and the
  // millisecond timestamp mode now have arms, so what is left is the ordinary divergence the rest
  // of this ledger already carries: a byte column typed as `Uint8Array` where official demands a
  // `Buffer`, and a date column that coerces on write where official does not.
  //
  // Note the timestamp pair is write modes only. On select the two agree exactly, which is the
  // shape of a defect fixed rather than moved.
  'sqlite/s_blob': { libs: LIB_NAMES, modes: MODE_NAMES, divergence: { '*/*': `L: Uint8Array | T: ` }, drzl: 'as pg/c_bytea', official: 'as pg/c_bytea', filed: 'not a defect: as pg/c_bytea' },
  'sqlite/s_blob_buf': { libs: LIB_NAMES, modes: MODE_NAMES, divergence: { '*/*': `L: Uint8Array | T: ` }, drzl: 'as sqlite/s_blob', official: 'as sqlite/s_blob', filed: 'as sqlite/s_blob' },
  'sqlite/s_n_blob': { libs: LIB_NAMES, modes: MODE_NAMES, divergence: { '*/*': `L: Uint8Array | T: ` }, drzl: 'as sqlite/s_blob', official: 'as sqlite/s_blob', filed: 'as sqlite/s_blob' },
  'sqlite/s_int_ts_ms': { libs: LIB_NAMES, modes: WRITE, divergence: { '*/*': `L: 0, 1, 1.5, -1, 200, 40000, 9000000, 2147483648, 1900, 2000, 2500, '2020-01-01', '2020-01-01T00:00:00Z', 17, 18, 50, 100, 101, 4294967295, 4294967296 | T: ` }, drzl: 'as pg/c_date_d', official: 'as pg/c_date_d', filed: 'not a defect: as pg/c_date_d' },
  'sqlite/s_n_ts_ms': { libs: LIB_NAMES, modes: WRITE, divergence: { '*/*': `L: 0, 1, 1.5, -1, 200, 40000, 9000000, 2147483648, 1900, 2000, 2500, '2020-01-01', '2020-01-01T00:00:00Z', 17, 18, 50, 100, 101, 4294967295, 4294967296 | T: ` }, drzl: 'as sqlite/s_int_ts_ms', official: 'as sqlite/s_int_ts_ms', filed: 'as sqlite/s_int_ts_ms' },

  // Two independent differences meet on this column, and only the first of them is in the v1 pass.
  //
  //   code points   a character limit counts characters; official counts `.length`, which is
  //                 UTF-16 units, so it refuses three emoji in a char(4) the database accepts.
  //   exact length  drizzle-zod 0.8.3 emits `length_equals 4`, on all three modes. Official v1
  //                 emits a maximum and no minimum, which is what DRZL emits on both majors, so
  //                 only the 0.4x module can see this at all.
  //
  // The exact-length half is upstream being stricter than the database on write, measured against
  // Postgres through PGlite rather than argued: `insert into t (c) values ('ab')` into a `char(4)`
  // is accepted and reads back as `'ab  '`, four characters. So official 0.4x refuses a legal
  // insert, and DRZL's select schema is the loose one, since a row from that column is always
  // four characters wide.
  'pg/c_char': {
    libs: LIB_NAMES,
    modes: MODE_NAMES,
    divergence: { '*/*': `L: "", 3 emoji, 'zzz', 'a', 'x', '010' | T: ` },
    drzl: 'a string of at most 4 code points',
    official: 'a string of exactly 4 UTF-16 units',
    filed: 'not a defect: two deliberate differences, see the note above',
  },
  'mysql/m_char': {
    libs: LIB_NAMES,
    modes: MODE_NAMES,
    divergence: { '*/*': `L: "", 3 emoji, 'zzz', 'a', 'x', '010' | T: ` },
    drzl: 'as pg/c_char',
    official: 'as pg/c_char',
    filed: 'as pg/c_char',
  },
  // MySQL caps the TEXT family in bytes; official caps it in UTF-16 units. A real MySQL 8 on a
  // utf8mb4 client is the authority and puts DRZL on the right side of it: a 100 emoji string is
  // 200 units and 400 bytes, `insert into caps (t) values (?)` into a `tinytext` fails with "Data
  // too long", and the same string goes into a `varchar(255)` and reports `length` 400 with
  // `char_length` 100. So one table has a byte budget and a character count side by side.
  //
  // Until the pool carried that string, all four MySQL text columns reported parity on both
  // majors while `mtext.t_text.maxLength` and its three siblings were filed against them. The
  // green line was not agreement, it was a pool with nothing in it that could tell the two counts
  // apart: every other string here is ascii, where they coincide, or too short to reach a cap.
  //
  // Which of the four columns this reaches is a property of the pool and is settled by arithmetic
  // rather than by trying strings. A separating probe must be over the cap in bytes and not over it
  // in UTF-16 units, and UTF-8 spends at most 3 bytes per unit, so it needs more than cap/3 units:
  // 86 for `tinytext` and 21846 for `text`, both carried in the pool, 5592406 for `mediumtext`,
  // which is a 10.7 MiB string measured by the byte-cap stage below instead of by every pairing,
  // and 1431655766 for `longtext`, which is more than V8 will let a string be.
  'mysql/m_tinytext': {
    libs: LIB_NAMES,
    modes: MODE_NAMES,
    divergence: { '*/*': `L:  | T: 100 emoji` },
    drzl: 'a string of at most 255 UTF-8 bytes, which is the column budget',
    official: 'a string of at most 255 UTF-16 units, so it takes 400 bytes into a 255 byte column',
    filed: 'not a defect: DRZL is stricter, and MySQL itself refuses what official accepts',
  },
  // The same thing on `text`, reached by the 22000 CJK probe rather than the emoji one: 66000
  // bytes over 22000 units against a 65535 byte budget. Filed as `mtext.t_text.maxLength`, and it
  // sat under a green parity line on both majors until that probe existed.
  'mysql/m_text': {
    libs: LIB_NAMES,
    modes: MODE_NAMES,
    divergence: { '*/*': `L:  | T: 22000 cjk` },
    drzl: 'a string of at most 65535 UTF-8 bytes, which is the column budget',
    official: 'a string of at most 65535 UTF-16 units, so it takes 66000 bytes into a 65535 byte column',
    filed: 'not a defect: as mysql/m_tinytext',
  },
  // `coerceDates` defaults to coercing on insert and update, which is a documented DRZL option and
  // is what `coerceDates: 'none'` turns off to match official exactly. Only strings and numbers
  // are coerced: null, booleans and arrays are still rejected.
  'pg/c_date_d': {
    libs: LIB_NAMES,
    modes: WRITE,
    divergence: {
      '*/*': `L: 0, 1, 1.5, -1, 200, 40000, 9000000, 2147483648, 1900, 2000, 2500, '2020-01-01', '2020-01-01T00:00:00Z', 17, 18, 50, 100, 101, 4294967295, 4294967296 | T: `,
    },
    drzl: 'a Date, or a string or number coerced to one',
    official: 'a Date only',
    filed: 'not a defect: coerceDates',
  },
  'pg/c_ts_d': { libs: LIB_NAMES, modes: WRITE, divergence: { '*/*': `L: 0, 1, 1.5, -1, 200, 40000, 9000000, 2147483648, 1900, 2000, 2500, '2020-01-01', '2020-01-01T00:00:00Z', 17, 18, 50, 100, 101, 4294967295, 4294967296 | T: `,     }, drzl: 'as pg/c_date_d', official: 'as pg/c_date_d', filed: 'as pg/c_date_d' },
  'mysql/m_date': { libs: LIB_NAMES, modes: WRITE, divergence: { '*/*': `L: 0, 1, 1.5, -1, 200, 40000, 9000000, 2147483648, 1900, 2000, 2500, '2020-01-01', '2020-01-01T00:00:00Z', 17, 18, 50, 100, 101, 4294967295, 4294967296 | T: `,     }, drzl: 'as pg/c_date_d', official: 'as pg/c_date_d', filed: 'as pg/c_date_d' },
  'mysql/m_datetime': { libs: LIB_NAMES, modes: WRITE, divergence: { '*/*': `L: 0, 1, 1.5, -1, 200, 40000, 9000000, 2147483648, 1900, 2000, 2500, '2020-01-01', '2020-01-01T00:00:00Z', 17, 18, 50, 100, 101, 4294967295, 4294967296 | T: `,     }, drzl: 'as pg/c_date_d', official: 'as pg/c_date_d', filed: 'as pg/c_date_d' },
  'mysql/m_ts': { libs: LIB_NAMES, modes: WRITE, divergence: { '*/*': `L: 0, 1, 1.5, -1, 200, 40000, 9000000, 2147483648, 1900, 2000, 2500, '2020-01-01', '2020-01-01T00:00:00Z', 17, 18, 50, 100, 101, 4294967295, 4294967296 | T: `,     }, drzl: 'as pg/c_date_d', official: 'as pg/c_date_d', filed: 'as pg/c_date_d' },
  'sqlite/s_int_ts': { libs: LIB_NAMES, modes: WRITE, divergence: { '*/*': `L: 0, 1, 1.5, -1, 200, 40000, 9000000, 2147483648, 1900, 2000, 2500, '2020-01-01', '2020-01-01T00:00:00Z', 17, 18, 50, 100, 101, 4294967295, 4294967296 | T: `,     }, drzl: 'as pg/c_date_d', official: 'as pg/c_date_d', filed: 'as pg/c_date_d' },
  // TypeBox fails a format it has no entry for rather than ignoring it, so official's schema
  // rejects every valid uuid in any project that has not populated `FormatRegistry` first.
  'pg/c_uuid': {
    libs: ['typebox'],
    modes: MODE_NAMES,
    divergence: { '*/*': `L: uuid | T: ` },
    drzl: 'a string carrying a uuid pattern, which needs no setup',
    official: "Type.String({ format: 'uuid' }), which rejects every uuid until FormatRegistry is populated",
    filed: 'not a defect: DRZL is the usable one',
  },
  // Stricter than official, in DRZL's favour, on every json column of every dialect.
  'pg/c_json': {
    libs: ['valibot'],
    modes: MODE_NAMES,
    divergence: { '*/*': `L:  | T: Infinity, Date, Buffer, Uint8Array` },
    drzl: 'a JSON value: no Infinity, no Date, no Buffer',
    official: 'v.any(), which takes all three',
    filed: 'not a defect: DRZL is stricter',
  },
  'pg/c_jsonb': { libs: ['valibot'], modes: MODE_NAMES, divergence: { '*/*': `L:  | T: Infinity, Date, Buffer, Uint8Array` }, drzl: 'as pg/c_json', official: 'as pg/c_json', filed: 'as pg/c_json' },
  'pg/c_jsonb_typed': { libs: ['valibot'], modes: MODE_NAMES, divergence: { '*/*': `L:  | T: Infinity, Date, Buffer, Uint8Array` }, drzl: 'as pg/c_json', official: 'as pg/c_json', filed: 'as pg/c_json' },
  'mysql/m_json': { libs: ['valibot'], modes: MODE_NAMES, divergence: { '*/*': `L:  | T: Infinity, Date, Buffer, Uint8Array` }, drzl: 'as pg/c_json', official: 'as pg/c_json', filed: 'as pg/c_json' },
  'sqlite/s_text_json': { libs: ['valibot'], modes: MODE_NAMES, divergence: { '*/*': `L:  | T: Infinity, Date, Buffer, Uint8Array` }, drzl: 'as pg/c_json', official: 'as pg/c_json', filed: 'as pg/c_json' },
  'sqlite/s_blob_json': { libs: ['valibot'], modes: MODE_NAMES, divergence: { '*/*': `L:  | T: Infinity, Date, Buffer, Uint8Array` }, drzl: 'as pg/c_json', official: 'as pg/c_json', filed: 'as pg/c_json' },
  // Arrived here when `point` stopped being typed `string` on 0.4x and started being the tuple it
  // is. The v1 pass has carried the same entry all along, for the same reason: DRZL emits
  // `v.strictTuple` and official emits `v.tuple`, which ignores anything past the declared
  // members. The other three libraries reject a third element on both sides.
  //
  // Postgres is what makes DRZL the right one, rather than a preference for strictness. Asked
  // through PGlite on a real `point` column, `[1, 2, 3]` is handed to the driver as `(1,2)`,
  // because drizzle's `mapToDriverValue` reads `value[0]` and `value[1]` and nothing else. The
  // insert succeeds, the column stores `(1,2)`, and the row reads back as `[1, 2]`. So the value
  // official accepts is one the database silently truncates.
  //
  // `c_line` is not here, and not because it behaves differently. The longest array in the pool
  // is `[1,2,3]`, which both a strict and a lax 3-tuple accept, so nothing in it separates the two
  // at that arity. The run asserts every entry's libs and divergence, so listing `c_line` on a
  // difference nothing measures would fail this stage rather than pass quietly.
  'pg/c_point': {
    libs: ['valibot'],
    modes: MODE_NAMES,
    divergence: { '*/*': `L:  | T: [1,2,3]` },
    drzl: 'a strict tuple of exactly two numbers',
    official: 'v.tuple, which ignores a third element the column then drops',
    filed: 'not a defect: DRZL is stricter, and Postgres truncates what official accepts',
  },
  // Looser than official, on purpose, and looser on a numeric range rather than on a format or a
  // length, which is the part worth reading for. An earlier version of this sentence called these
  // six the only entries in either pass running that way; they are not, and the run now counts and
  // prints how many waivers do. The reasoning, the PGlite measurements and the two caveats are
  // written out once at the same keys in the v1 pass earlier in this gate, because both
  // majors now take the database's answer and moving one without the other is what the cross-major
  // diff catches.
  //
  // They were in DEFECTS below for one release, filed as "DRZL emits an unbounded number, official
  // emits a number within +/-8388607". The fix that closed that filed the wrong way: it adopted
  // official's bound, which refuses 8388608, 9000000, 1e9 and 2147483648 on a column that stores
  // and returns all four. Review measured the cost against the ground-truth pool at ten probes
  // Postgres stores and both DRZL and official refused. The bound is the database's now.
  //
  // `pg/c_numeric_n` is deliberately not among them. Its bound is the safe-integer range, which is
  // about what a JS number can carry rather than about the column, official emits the same one,
  // and Postgres is stricter than both: it refuses 2147483648 into a `numeric(10,2)`.
  // The arktype update arm gains `Infinity` alone. Official arktype already accepts NaN in its
  // union-shaped arms, so NaN was never a divergence there. Same split as the v1 pass.
  'pg/c_real': {
    libs: LIB_NAMES,
    modes: MODE_NAMES,
    divergence: {
      'select,insert/*': `L: 9000000, 2147483648, 9007199254740993, 3.4028235e38, NaN, Infinity, 4294967295, 4294967296 | T: `,
      'update/zod,valibot,typebox': `L: 9000000, 2147483648, 9007199254740993, 3.4028235e38, NaN, Infinity, 4294967295, 4294967296 | T: `,
      'update/arktype': `L: 9000000, 2147483648, 9007199254740993, 3.4028235e38, Infinity, 4294967295, 4294967296 | T: `,
    },
    drzl: 'a number within the magnitude Postgres accepts into a real, plus the non-finite values it stores',
    official: 'a number within +/-8388607, which refuses rows the column returns',
    filed: 'not a defect: the database is the arbiter, see the same key in the v1 pass',
  },
  // The analyzer reads precision and scale now, so this bounds where the column bounds and refuses
  // 2147483648, which `numeric(10,2)` answers 22003 for. Official reads neither number, so it
  // accepts a value the column will not hold. See the v1 copy for the full reasoning (AK).
  'pg/c_numeric_n': { libs: LIB_NAMES, modes: MODE_NAMES, divergence: { 'select,insert/*': `L: NaN | T: 2147483648, 4294967295, 4294967296`, 'update/zod,valibot,typebox': `L: NaN | T: 2147483648, 4294967295, 4294967296`, 'update/arktype': `L:  | T: 2147483648, 4294967295, 4294967296` }, drzl: 'a number bounded by the declared precision, plus the NaN Postgres stores', official: 'an unbounded number that refuses the NaN the database hands back', filed: 'not a defect: the database is the arbiter, as pg/c_real' },
  // Not `as pg/c_real` in the signature, which it was until MySQL was measured: the two 4 byte
  // floats have different edges, and `3.4028235e38` is the probe that says so.
  'mysql/m_float': { libs: LIB_NAMES, modes: MODE_NAMES, divergence: { '*/zod,valibot,typebox': `L: 9000000, 2147483648, 9007199254740993, 4294967295, 4294967296 | T: `, 'update/arktype': `L: 9000000, 2147483648, 9007199254740993, 4294967295, 4294967296 | T: NaN`, 'select,insert/arktype': `L: 9000000, 2147483648, 9007199254740993, 4294967295, 4294967296 | T: ` }, drzl: 'as pg/c_real, at the narrower MySQL edge', official: 'as pg/c_real', filed: 'as pg/c_real' },
  'pg/c_double': {
    libs: LIB_NAMES,
    modes: MODE_NAMES,
    divergence: {
      'select,insert/*': `L: 9007199254740993, 3.4028235e38, NaN, Infinity | T: `,
      'update/zod,valibot,typebox': `L: 9007199254740993, 3.4028235e38, NaN, Infinity | T: `,
      'update/arktype': `L: 9007199254740993, 3.4028235e38, Infinity | T: `,
    },
    drzl: 'an unbounded number, because no finite bound is true of an 8 byte float, plus the non-finite values it stores',
    official: 'a number within +/-140737488355327, which refuses an ordinary microsecond epoch',
    filed: 'not a defect: as pg/c_real',
  },
  // The `Infinity` term is gone from both, on this major as on the other: MySQL 8.4.11 refuses both
  // infinities on `float`, `double` and `real`, so DRZL refuses them too and agrees with official
  // there. Only the magnitudes are left, plus arktype's update-only NaN narrow. See the ALLOWED
  // entry in the v1 pass for the measurement (BU).
  'mysql/m_real': { libs: LIB_NAMES, modes: MODE_NAMES, divergence: { '*/zod,valibot,typebox': `L: 9007199254740993, 3.4028235e38 | T: `, 'update/arktype': `L: 9007199254740993, 3.4028235e38 | T: NaN`, 'select,insert/arktype': `L: 9007199254740993, 3.4028235e38 | T: ` }, drzl: 'as pg/c_double at the magnitudes, refusing both infinities as MySQL does', official: 'as pg/c_double', filed: 'as pg/c_real' },
  'mysql/m_double': { libs: LIB_NAMES, modes: MODE_NAMES, divergence: { '*/zod,valibot,typebox': `L: 9007199254740993, 3.4028235e38 | T: `, 'update/arktype': `L: 9007199254740993, 3.4028235e38 | T: NaN`, 'select,insert/arktype': `L: 9007199254740993, 3.4028235e38 | T: ` }, drzl: 'as mysql/m_real', official: 'as pg/c_double', filed: 'as pg/c_real' },
  'sqlite/s_real': { libs: LIB_NAMES, modes: MODE_NAMES, divergence: { '*/zod,typebox': `L: 9007199254740993, 3.4028235e38 | T: `, '*/valibot': `L: 9007199254740993, 3.4028235e38, Infinity | T: `, 'update/arktype': `L: 9007199254740993, 3.4028235e38, Infinity | T: NaN`, 'select,insert/arktype': `L: 9007199254740993, 3.4028235e38, Infinity | T: ` }, drzl: 'as pg/c_double', official: 'as pg/c_double', filed: 'as pg/c_real' },

  // ---- the nullable table --------------------------------------------------------------------
  // Each of these is the divergence its `notNull` twin in `matrix` already carries, measured again
  // through the wrapper each generator puts round a nullable column. A signature identical to the
  // twin's is the evidence that the wrapping loses nothing. Three have no twin and they are the
  // three CHECK columns: no column of `matrix` carries a CHECK, and no first-party module reads
  // one at all.
  'pg/n_real': { libs: LIB_NAMES, modes: MODE_NAMES, divergence: { '*/zod,valibot,typebox': `L: 9000000, 2147483648, 9007199254740993, 3.4028235e38, NaN, Infinity, 4294967295, 4294967296 | T: `, '*/arktype': `L: 9000000, 2147483648, 9007199254740993, 3.4028235e38, Infinity, 4294967295, 4294967296 | T: ` }, drzl: 'as pg/c_real', official: 'as pg/c_real', filed: 'as pg/c_real' },
  'pg/n_json': { libs: ['valibot'], modes: MODE_NAMES, divergence: { '*/*': `L:  | T: Infinity, Date, Buffer, Uint8Array` }, drzl: 'as pg/c_json', official: 'as pg/c_json', filed: 'as pg/c_json' },
  'pg/n_point': { libs: ['valibot'], modes: MODE_NAMES, divergence: { '*/*': `L:  | T: [1,2,3]` }, drzl: 'as pg/c_point', official: 'as pg/c_point', filed: 'as pg/c_point' },
  'pg/n_ts': { libs: LIB_NAMES, modes: WRITE, divergence: { '*/*': `L: 0, 1, 1.5, -1, 200, 40000, 9000000, 2147483648, 1900, 2000, 2500, '2020-01-01', '2020-01-01T00:00:00Z', 17, 18, 50, 100, 101, 4294967295, 4294967296 | T: `, }, drzl: 'as pg/c_date_d', official: 'as pg/c_date_d', filed: 'as pg/c_date_d' },
  // The database has already answered this one in this same script: the CHECK ground-truth stage
  // runs 59 probes over the `checked` table against a real Postgres and reports rows Postgres
  // rejects and the validator accepts as DRZL 0, drizzle-orm 24, and `k_between BETWEEN 5 AND 15`
  // there is this column's own CHECK form. The v1 copy of this entry carries the rest of the
  // reasoning, including why the bound is two-sided.
  'pg/n_check': { libs: LIB_NAMES, modes: MODE_NAMES, divergence: { '*/*': `L:  | T: 0, 1, -1, 200, 40000, 9000000, 1900, 2000, 2500, 17, 101` }, drzl: 'the column CHECK, as a bound', official: 'no CHECK at all: no first-party module reads one', filed: 'not a defect: this is what DRZL is for' },
  'mysql/m_n_text': { libs: LIB_NAMES, modes: MODE_NAMES, divergence: { '*/*': `L:  | T: 22000 cjk` }, drzl: 'as mysql/m_text', official: 'as mysql/m_text', filed: 'as mysql/m_text' },
  'mysql/m_n_tinytext': { libs: LIB_NAMES, modes: MODE_NAMES, divergence: { '*/*': `L:  | T: 100 emoji` }, drzl: 'as mysql/m_tinytext', official: 'as mysql/m_tinytext', filed: 'as mysql/m_tinytext' },
  'mysql/m_n_float': { libs: LIB_NAMES, modes: MODE_NAMES, divergence: { '*/zod,valibot,typebox': `L: 9000000, 2147483648, 9007199254740993, 4294967295, 4294967296 | T: `, '*/arktype': `L: 9000000, 2147483648, 9007199254740993, 4294967295, 4294967296 | T: NaN` }, drzl: 'as mysql/m_float', official: 'as mysql/m_float', filed: 'as pg/c_real' },
  'mysql/m_n_json': { libs: ['valibot'], modes: MODE_NAMES, divergence: { '*/*': `L:  | T: Infinity, Date, Buffer, Uint8Array` }, drzl: 'as pg/c_json', official: 'as pg/c_json', filed: 'as pg/c_json' },
  'mysql/m_n_datetime': { libs: LIB_NAMES, modes: WRITE, divergence: { '*/*': `L: 0, 1, 1.5, -1, 200, 40000, 9000000, 2147483648, 1900, 2000, 2500, '2020-01-01', '2020-01-01T00:00:00Z', 17, 18, 50, 100, 101, 4294967295, 4294967296 | T: `, }, drzl: 'as pg/c_date_d', official: 'as pg/c_date_d', filed: 'as pg/c_date_d' },
  'mysql/m_n_check': { libs: LIB_NAMES, modes: MODE_NAMES, divergence: { '*/*': `L:  | T: 0, 1, -1, 200, 40000, 9000000, 1900, 2000, 2500, 17, 101` }, drzl: 'as pg/n_check', official: 'as pg/n_check', filed: 'as pg/n_check' },
  'sqlite/s_n_real': { libs: LIB_NAMES, modes: MODE_NAMES, divergence: { '*/zod,typebox': `L: 9007199254740993, 3.4028235e38 | T: `, '*/valibot': `L: 9007199254740993, 3.4028235e38, Infinity | T: `, '*/arktype': `L: 9007199254740993, 3.4028235e38, Infinity | T: NaN` }, drzl: 'as pg/c_double', official: 'as pg/c_double', filed: 'as pg/c_real' },
  'sqlite/s_n_json': { libs: ['valibot'], modes: MODE_NAMES, divergence: { '*/*': `L:  | T: Infinity, Date, Buffer, Uint8Array` }, drzl: 'as pg/c_json', official: 'as pg/c_json', filed: 'as pg/c_json' },
  'sqlite/s_n_ts': { libs: LIB_NAMES, modes: WRITE, divergence: { '*/*': `L: 0, 1, 1.5, -1, 200, 40000, 9000000, 2147483648, 1900, 2000, 2500, '2020-01-01', '2020-01-01T00:00:00Z', 17, 18, 50, 100, 101, 4294967295, 4294967296 | T: `, }, drzl: 'as pg/c_date_d', official: 'as pg/c_date_d', filed: 'as pg/c_date_d' },
  'sqlite/s_n_check': { libs: LIB_NAMES, modes: MODE_NAMES, divergence: { '*/*': `L:  | T: 0, 1, -1, 200, 40000, 9000000, 2147483648, 1900, 2000, 2500, 17, 101, 4294967295, 4294967296` }, drzl: 'as pg/n_check', official: 'as pg/n_check', filed: 'as pg/n_check' },
  // ---- binary and varbinary, where only DRZL enforces the declared width ----------------------
  // These two were DEFECTS here until the analyzer stopped calling a byte string a Uint8Array. They
  // are waivers now because DRZL is the stricter side and the server agrees with it.
  //
  // `L:` is empty in all twelve pairings, where it used to carry Buffer and Uint8Array: DRZL is no
  // longer looser than official anywhere on this major. Official 0.4x emits a bare string with no
  // cap at all, so every value in `T:` is one over the declared byte width that official takes and
  // both DRZL and MySQL refuse.
  //
  // '3 emoji' on m_binary and '5 emoji' on m_varbinary sit in insert and update and not in select,
  // which is the cap being direction-dependent rather than noise: 12 bytes does not fit a
  // binary(4) and 20 does not fit a varbinary(16), while a value already in the column came from a
  // server that had room for it.
  'mysql/m_binary': { libs: LIB_NAMES, modes: MODE_NAMES, divergence: { 'select/*': `L:  | T: 'hello', 300-char, 70k-char, 5-char, 5 emoji, 'not-a-uuid', uuid, 'happy', '2020-01-01', '2020-01-01T00:00:00Z', '12:00:00', '25:99:99', 100 emoji, 22000 cjk, '999.999.999.999', '10.0.0.1'`, 'insert,update/*': `L:  | T: 'hello', 300-char, 70k-char, 5-char, 3 emoji, 5 emoji, 'not-a-uuid', uuid, 'happy', '2020-01-01', '2020-01-01T00:00:00Z', '12:00:00', '25:99:99', 100 emoji, 22000 cjk, '999.999.999.999', '10.0.0.1'` }, drzl: 'a string capped at the declared byte width', official: 'an uncapped string', filed: 'not a defect: DRZL is stricter here and the server agrees' },
  'mysql/m_varbinary': { libs: LIB_NAMES, modes: MODE_NAMES, divergence: { 'select/*': `L:  | T: 300-char, 70k-char, uuid, '2020-01-01T00:00:00Z', 100 emoji, 22000 cjk`, 'insert,update/*': `L:  | T: 300-char, 70k-char, 5 emoji, uuid, '2020-01-01T00:00:00Z', 100 emoji, 22000 cjk` }, drzl: 'as mysql/m_binary', official: 'as mysql/m_binary', filed: 'as mysql/m_binary' },
  // ---- geometry, where DRZL counts the coordinates and official does not ----------------------
  // These were DEFECTS across all four libraries while the class-name path could not name a
  // `geometry` column at all. It is named now and what survives is one library and one direction:
  // valibot's `v.tuple` ignores a third element, so official takes `[1,2,3]` into a two-coordinate
  // point and DRZL's tuple shape refuses it. ALLOWED[pg/n_point] already records the same valibot
  // capability difference from the other side.
  'pg/c_geometry': { libs: ['valibot'], modes: MODE_NAMES, divergence: { '*/valibot': `L:  | T: [1,2,3]` }, drzl: 'a two-number tuple', official: 'an array of any length', filed: 'not a defect: DRZL counts the coordinates and the server agrees' },
  'pg/n_geometry': { libs: ['valibot'], modes: MODE_NAMES, divergence: { '*/valibot': `L:  | T: [1,2,3]` }, drzl: 'as pg/c_geometry', official: 'as pg/c_geometry', filed: 'as pg/c_geometry' },
};

/**
 * Where DRZL is wrong on 0.4x, whichever way the difference runs.
 *
 * Not "looser than official", which is the neighbouring map's business as often as this one's:
 * ALLOWED above holds columns where DRZL is looser and right, because the database says so, and
 * the run prints how many of its entries run that way rather than a sentence here claiming a
 * number. The sentence that used to stand here said six, and the nullable twins added since made
 * it nine.
 * What puts an entry here is that DRZL's answer is wrong about the column.
 *
 * `filed: 'AC: ...'` names the fields the cross-major stage above already carries for the same
 * column. The two sets do not line up one to one and were never going to: that map records the
 * analyzer describing a column differently per major, and this one records the emitted validator
 * behaving differently from the first-party one. How many of these columns are filed there and how
 * many are new is not written here: the run splits this map on its own `filed` strings and prints
 * both, a few lines above the entries themselves. The sentence that stood here gave the second
 * number, and it was the ledger's size at the branch base rather than its size now, which the
 * nullable twins moved in the same edit that moved everything else this branch had to correct.
 * The new ones are mostly new because the cross-major fixture is Postgres plus four MySQL text
 * columns, so no MySQL binary, no MySQL year and no SQLite column of any kind had ever been
 * described under both majors.
 *
 * Nine entries have left this map, which is what it is for, and they left by two different doors.
 *
 * `pg/c_point` and `pg/c_line` were the class-name path answering `string` for a value the driver
 * hands back as a tuple. Fixed in the analyzer, and gone from both maps except for the valibot
 * strict-tuple entry above, which is DRZL being the stricter one.
 *
 * `pg/c_real`, `pg/c_double`, `mysql/m_real`, `mysql/m_double`, `mysql/m_float` and
 * `sqlite/s_real` were an inexact numeric column carrying no bound at all. They are in ALLOWED
 * above now rather than gone: they are still divergences, in the opposite direction, because the
 * bound DRZL adopted is the database's and not official's. `pg/c_numeric_n` is the one that is
 * simply gone, since its safe-integer bound is what official emits too.
 *
 * Removing an entry before the fix is what showed the entry was covering the defect: taking the
 * nine out on their own failed this stage with 108 parity findings naming exactly those nine
 * columns.
 *
 * Two kinds of filed defect are not in this map, and they are not there for different reasons.
 *
 * Invisible, because official is equally loose. `matrix.c_numeric.format` and its two siblings are
 * the numeric pattern being attached on the v1 arm only, so on 0.4x DRZL emits a bare string for
 * `c_numeric` and `c_decimal` and takes 'hello' back. Official drizzle-zod 0.8.3 emits a bare
 * string there too, so the two agree and this comparison reports nothing however it is probed. The
 * cross-major diff is what sees that one.
 *
 * Visible, and pointing the other way. `mtext.t_*.maxLength` is four filed fields on the MySQL text
 * family, and this comparison reports parity for all four, because the difference it would show is
 * DRZL being the stricter and correct one. Where each of the four is actually measured, since a
 * green `parity` line over a filed field is the thing a ledger is supposed to make impossible and
 * an earlier version of this paragraph claimed all four were in ALLOWED when two were not:
 *
 *   t_tiny     ALLOWED[mysql/m_tinytext], from the 100 emoji probe, and the byte-cap stage
 *   t_text     ALLOWED[mysql/m_text], from the 22000 CJK probe, and the byte-cap stage
 *   t_medium   the byte-cap stage alone. Its separating string is 10.7 MiB, too heavy for a pool.
 *   t_long     nothing. Its separating string would need more units than V8 will put in a string,
 *              and the byte-cap stage prints it by name as unprobeable rather than omitting it.
 *
 * So one of the four is genuinely uncovered, it is uncovered for a reason that is arithmetic
 * rather than effort, and the run says so out loud.
 */
const DEFECTS: Record<string, Entry> = {
  // ---- columns the class-name path cannot name at all ----------------------------------------
  // No arm for the class, so the column comes back `unknown` and every generator emits a validator
  // that accepts anything. The three Postgres ones are also named in check-old.ts, as an absolute
  // check rather than a relative one. The three SQLite ones are new here: `SQLiteBlobBuffer` and
  // the millisecond timestamp mode have no arm either, and no SQLite fixture had ever been
  // analyzed under 0.4x.
  //
  // A bare `blob()` is not the same column on the two majors, measured on the column object:
  // 0.45.2 builds a `SQLiteBlobBuffer` and 1.0.0-rc.4 builds a `SQLiteBlobJson`. So `s_blob` and
  // `s_blob_buf` are both buffer columns here, which is why official demands a Buffer for both.
  // `pg/c_bit` and `pg/n_bit` stood here and are gone: the column is named, so nothing about it
  // diverges from official any more. `pg/c_geometry` and `pg/n_geometry` moved to `ALLOWED` above,
  // narrowed from all four libraries and twelve pairings to valibot and three, in the one direction
  // where DRZL is the stricter and correct side.

  // ---- a wrong type on MySQL -----------------------------------------------------------------
  // The class-name path answering with the wrong JavaScript type rather than with nothing.
  // `binary` and `varbinary` are strings on both majors and DRZL calls them Uint8Array, which
  // shows up as DRZL refusing everything official takes and taking things official refuses.
  //
  // `MySqlDecimal` used to sit here as the second of two. It was fixed rather than waived: the
  // analyzer now types each decimal mode as what the driver hands back, measured against a live
  // MySQL 8.4. Its entry went with it, because a ledger entry that suppresses nothing fails this
  // stage by design.
  // The two official majors do not agree about this column, so `official: a string` is only half
  // the picture and a reader needs the rest before acting on it. Measured on the column object and
  // ---- an integer range is missing or wrong on 0.4x ------------------------------------------
  // `sqlite/s_int` is three libraries rather than four, and the missing one is not an omission:
  // zod's `.int()` refuses a number outside the safe-integer range on its own, so zod reaches
  // official's answer for 9007199254740993 without the bound DRZL failed to emit. The other three
  // have no such rule and take it.
  'mysql/m_year': {
    libs: LIB_NAMES,
    modes: MODE_NAMES,
    divergence: {
      '*/zod': `L: 0, 1, -1, 200, 40000, 9000000, 2147483648, 1900, 2500, 17, 18, 50, 100, 101, 4294967295, 4294967296 | T: `,
      '*/valibot,arktype,typebox': `L: 0, 1, -1, 200, 40000, 9000000, 2147483648, 9007199254740993, 3.4028235e38, 1900, 2500, 17, 18, 50, 100, 101, 4294967295, 4294967296 | T: `,
    },
    drzl: 'an unbounded integer',
    official: 'an integer within 1901..2155',
    filed: 'new',
  },
  'sqlite/s_int': {
    libs: ['valibot', 'arktype', 'typebox'],
    modes: MODE_NAMES,
    divergence: { '*/*': `L: 9007199254740993 | T: ` },
    drzl: 'an integer within the signed 64-bit range',
    official: 'an integer within the safe-integer range',
    filed: 'new',
  },
  'sqlite/s_blob_bigint': {
    libs: LIB_NAMES,
    modes: MODE_NAMES,
    divergence: { '*/*': `L: 2n**70n, 18446744073709551615n, 18446744073709551616n | T: ` },
    drzl: 'an unbounded bigint',
    official: 'a bigint within the signed 64-bit range',
    filed: 'new',
  },

  // ---- the nullable table, where the same 0.4x defects show up again -------------------------
  // Each of these is its `matrix` twin's defect measured through a nullable wrapper, which is what
  // says the defect is in the analysis of the column rather than in one emitted shape.
  // The other two Postgres classes the class-name path cannot name. All five classes that produce
  // this shape are in the fixture now, three here and two on SQLite below.
  // `pg/n_geometry` and `pg/n_bit` were here, the nullable twins of the two above, and went
  // the same way for the same reason: the classes are named, so a nullable one is no longer an
  // unknown wrapped in a union.
  'sqlite/s_n_int': {
    libs: ['valibot', 'arktype', 'typebox'],
    modes: MODE_NAMES,
    divergence: { '*/*': `L: 9007199254740993 | T: ` },
    drzl: 'as sqlite/s_int',
    official: 'as sqlite/s_int',
    filed: 'as sqlite/s_int',
  },
  // The same column type with a default on it, which is why it carries the same defect. Its
  // divergence is exactly `sqlite/s_n_int`'s and not the default's: `applyDefaults` is off in this
  // config, so neither side fills anything in.
  'sqlite/s_n_default': {
    libs: ['valibot', 'arktype', 'typebox'],
    modes: MODE_NAMES,
    divergence: { '*/*': `L: 9007199254740993 | T: ` },
    drzl: 'as sqlite/s_int',
    official: 'as sqlite/s_int',
    filed: 'as sqlite/s_int',
  },
  'sqlite/s_n_bigint': {
    libs: LIB_NAMES,
    modes: MODE_NAMES,
    divergence: { '*/*': `L: 2n**70n, 18446744073709551615n, 18446744073709551616n | T: ` },
    drzl: 'as sqlite/s_blob_bigint',
    official: 'as sqlite/s_blob_bigint',
    filed: 'as sqlite/s_blob_bigint',
  },
};

/**
 * Where DRZL and the official 0.4x module disagree about whether a key may be missing.
 *
 * A ledger of its own, because it answers a question of its own: the maps above are about what a
 * schema does with a value, and this is about whether the object needs the key at all. Same shape
 * and same both-directions assertion, with the signature `official <required|optional>, DRZL <the
 * same two>` per pairing.
 *
 * Both entries are the same defect wearing a different coat. On 0.4x the analyzer cannot name these
 * columns, so DRZL emits an unknown for them, and on TypeBox a *nullable* unknown is
 * `Type.Union([Type.Unknown(), Type.Null()])`, which lets the key be missing. Three measurements on
 * TypeBox itself, not on anything DRZL emits:
 *
 *   Type.Object({ k: Type.Unknown(), other })          the key omitted   rejected
 *   Type.Object({ k: Union([Unknown, Null]), other })  the key omitted   accepted
 *   the same object with the key present                                 accepted
 *
 * So it is the nullable form and not the unknown that opens it, and that is why no column of
 * `matrix` is here. The ones unnamed on this major are `c_geometry`, `c_bit`, `c_vector`,
 * `s_blob`, `s_blob_buf` and `s_int_ts_ms`. They are `notNull`,
 * so they emit a bare `Type.Unknown()` and their keys stay required, which this run measures: an
 * entry for any of them would fail as dead. The three Postgres ones are read on update alone,
 * because `PRESENCE_BARREN` below makes select and insert unreadable on that pairing, and update is
 * where both sides make every key optional anyway.
 *
 * A row that never mentions the column validates against the entries that are here, and the
 * field-level comparison cannot see it, because TypeBox keeps requiredness on the parent.
 *
 * Only TypeBox. zod, valibot and arktype all keep the key required for their nullable unknown, and
 * this run measures that rather than assuming it: an entry naming another library fails, and a
 * library that starts doing it and is not named fails too.
 */
/**
 * Where the presence axis cannot read a side at all, because that side's schema for the column
 * accepts nothing in the pool and so no object satisfying it exists.
 *
 * The same one column as the v1 pass, for the same reason `ALLOWED[pg/c_uuid]` above records:
 * official emits `Type.String({ format: 'uuid' })` and TypeBox fails a format it has no entry for,
 * so that field refuses every value. On select and insert the column is required, so no object
 * satisfying official's Postgres TypeBox schema exists and no key of it can be asked about; on
 * update it is optional and only that column is lost. Asserted in both directions.
 */
const PRESENCE_BARREN: Record<string, string> = {
  'pg/typebox/c_uuid': "official's Type.String({ format: 'uuid' }) refuses every value with no FormatRegistry",
};

/**
 * The absolute half of the presence axis: on `select`, DRZL's own schema has to require every key.
 *
 * `PRESENCE` below is differential and can only see DRZL and official disagreeing. This fires where
 * they agree about something wrong, and it fires where official cannot answer at all: `pg/n_bit` is
 * in this list and not in `PRESENCE`, because official's TypeBox schema throws on the object with
 * that key omitted rather than reporting it missing, so there is no verdict to differ from.
 *
 * A select row always carries every column, so an optional key there is wrong however many
 * libraries agree about it. Keyed `<dialect>/<library>/<column>` and asserted in both directions.
 *
 * Five column classes reach it on this major and all five are here: `PgVector`, `PgGeometry`,
 * `PgBinaryVector`, `SQLiteBlobBuffer` and `integer({ mode: 'timestamp_ms' })`, each of them a
 * column the class-name path cannot name, plus the customType, which is unnamed on both majors.
 * Only TypeBox: zod, valibot and arktype keep the key required for their own nullable unknown.
 */
/**
 * How far the check below actually reached, declared and asserted in both directions, for the
 * reason the v1 copy carries: an absolute check has no second side, so a shrinking reach prints the
 * same line and finds nothing. Measured on the v1 pass by making a select schema barren at a column
 * already declared in `PRESENCE_BARREN`, which dropped 40 keys and hid a real optional one.
 */
const SELECT_REACH = { schemas: 24, keys: 500 };

const SELECT_OPTIONAL: Record<string, string> = {
  // The three Postgres entries that stood here are gone, and nobody edited them out: naming
  // `vector`, `geometry` and `bit` means those columns no longer emit an unknown, so their nullable
  // form is no longer the union whose TypeBox key may go missing, and this check retired each one
  // by name as its arm landed. Only SQLite is left, where two classes are still unnamed.
};

const PRESENCE: Record<string, Entry> = {
  // `pg/n_geometry` sat here for the same reason and left with the rest of them.
  // The two entries that stood here said DRZL was the looser side, its TypeBox key going missing
  // where official's stayed required. Both columns are named now, so neither is an unknown and
  // neither key can go missing. What replaces them points the other way (AQ).
  //
  // `s_n_custom` cannot be named by anything: a `customType` has no runtime shape to read. So it
  // is the one column where the fix is visible as a divergence, and the direction is DRZL being
  // stricter than the first-party module rather than looser.
  'sqlite/s_n_custom': {
    libs: ['typebox'],
    modes: ['select'],
    divergence: { '*/*': 'official optional, DRZL required' },
    drzl: 'a bare unknown, which admits null and keeps its key',
    official: 'Type.Union([Type.Unknown(), Type.Null()]), whose key TypeBox lets go missing',
    filed: 'not a defect: a row missing a declared column should not validate',
  },
  // No `pg/n_bit` entry, and its absence is the reason SELECT_OPTIONAL existed next to this map:
  // official's TypeBox schema throws on the object with that key omitted rather than reporting it
  // missing, so this differential comparison has no verdict to differ from.
};

// A field lookup that throws yields nothing, and nothing is not read as agreement anywhere below:
// every branch that reaches an absent field pushes a finding row. Measured on this run, it throws
// zero times, so the catch is a guard rather than a path anything travels. Verdicts go through
// `probe` in pool.ts, which does not treat a crash as a rejection.
const safeField = (lib: Lib, s: any, k: string) => {
  try {
    return lib.field(s, k);
  } catch {
    return undefined;
  }
};

/**
 * Probes where one side crashes instead of answering. Declared exactly and asserted in both
 * directions, keyed `<dialect>/<library>/<column>`.
 *
 * A crash is not a verdict, so the value it happened on is not compared for that column. It is
 * recorded here instead, which is what stops a swallowed exception from being scored as the other
 * side's answer.
 *
 * Not comparing it is not the same as not measuring it, and for a while it was: the value was
 * dropped and nothing looked at DRZL's answer, which made a crashing official module a licence for
 * DRZL to do anything on that value. So two more fields, both asserted:
 *
 *   `drzl`     what DRZL answers on the crashed value, keyed `<mode-or-*>/<value>`. Every crashed
 *              probe has to be claimed by exactly one declaration and match it, and every
 *              declaration has to claim at least one probe.
 *   `arbiter`  what settles that DRZL's answer is the right one, keyed by value, computed by the
 *              run rather than believed. A real Postgres through PGlite wherever one runs for that
 *              dialect; and where none does, the reason, also computed.
 *
 * On this major `c_bit` is one of the columns the analyzer cannot name, so DRZL takes every
 * value including a NULL for a NOT NULL column, and takes the column being left out of the insert
 * as well. That is the filed defect DEFECTS[pg/c_bit] carries, and the arbitration prints a line
 * per probe saying so: the database refuses it, DRZL accepts it, and the map naming the column is
 * what keeps that from being a hard failure here too. Until this round it did not print anything.
 * The claim that it "says so out loud rather than passing over it" stood over a branch guarded by
 * `!DEFECTS[...]`, so the entry that made the sentence worth writing was also what stopped it from
 * ever running, and the run printed a count and nothing else.
 */
type Crash = {
  side: string;
  modes: string[];
  values: string[];
  why: string;
  /** What DRZL answers where official crashed, keyed `<mode-or-*>/<value>`. */
  drzl: Record<string, string>;
  /** What settles that answer, keyed by value. Computed by the run and compared with this. */
  arbiter: Record<string, string>;
  /**
   * The modes in which the same side crashes on the *object* with this key omitted, rather than
   * reporting the key missing. Same upstream cause as the value crashes above: the length check
   * reads `value.length` of the absent property. Asserted in both directions.
   */
  absentModes: string[];
};
const THREW: Record<string, Crash> = {
  // Official emits `{ type: 'RegExp', source: '^[01]+$', maxLength: 3 }`, and TypeBox's length
  // check reads `value.length` with no type guard, so `null` and `undefined` crash it rather than
  // failing it. `drizzle-orm/typebox-legacy` on 1.0.0-rc.4 does the same, so this is an upstream
  // defect on both majors rather than a difference between them.
  //
  // One site here and three in the v1 pass, and the difference is upstream rather than arbitrary:
  // the crashing columns are exactly the columns official emits as `type: 'RegExp'`, enumerated on
  // both majors, and this module emits a bare string for `m_binary` and `m_varbinary` where the v1
  // one emits a capped pattern. Nothing DRZL emits crashes on any probe, on either major.
  'pg/typebox/c_bit': {
    side: 'official',
    modes: ['select', 'insert', 'update'],
    values: ['null', 'undefined'],
    why: 'official Type.RegExp with maxLength reads .length of a null value',
    // Every probe, because the analyzer names no type for this column on 0.4x. The other three
    // libraries report the same thing through the ALL_PROBES signature in DEFECTS[pg/c_bit]; this
    // is the fourth, which the comparison cannot reach.
    drzl: { '*/null': 'reject', '*/undefined': 'reject' },
    arbiter: {
      // A real Postgres, built from this column's own `getSQLType()`, refuses a NULL into
      // `bit(3) not null` with a not-null violation, and its nullable twin takes one.
      null: 'postgres refuses it (SQLSTATE 23502)',
      // An absence is handed to a database by leaving the column out of the insert. What stood
      // here said no database could be handed one, on the evidence that a bound `undefined` comes
      // back 23502; that measures the driver's parameter binding and was written up as a fact
      // about databases. `pool.ts` asks it as an omission instead, and the twin carrying a default
      // is what keeps that from being the NULL answer under another name.
      undefined: 'postgres refuses the column omitted from the insert (SQLSTATE 23502)',
    },
    // No omission reaches this column: `c_uuid` on the same object accepts nothing on this major
    // either, so official's Postgres TypeBox schema has no satisfiable object. See PRESENCE_BARREN.
    absentModes: [],
  },
  // The nullable twin, and the same upstream defect. Two things differ and both follow from the
  // column being nullable: DRZL's answer is `accept` because the analyzer cannot name the column on
  // this major and an unknown takes everything, and Postgres agrees with that answer here rather
  // than refusing it, because the subject table this run builds carries the column's own
  // nullability. `absentModes` is select alone: insert and update make the key optional, so TypeBox
  // skips the property instead of reaching the length check.
  'pg/typebox/n_bit': {
    side: 'official',
    modes: ['select', 'insert', 'update'],
    values: ['null', 'undefined'],
    why: 'as pg/typebox/c_bit',
    drzl: { '*/null': 'accept', '*/undefined': 'reject' },
    arbiter: {
      null: 'postgres accepts it',
      undefined: 'postgres accepts the column omitted from the insert',
    },
    absentModes: ['select'],
  },
};

/**
 * Columns the analyzer cannot name at all on 0.4x, in the two fixtures nothing else checks.
 *
 * The comparison above is differential and can only see DRZL and official disagreeing. This is
 * absolute, and it is what still fires when they agree about something wrong. `m_enum` used to be
 * the worked example: DRZL called it `unknown` while every generator recovered its members from
 * `enumValues`, so the emitted schema was right, the description was not, and nothing differential
 * could see it. It is named now and its entries are gone.
 * `check-old.ts` in the stage above does the same job for the Postgres and
 * MySQL-text fixtures; it cannot cover these two, because it runs before this stage writes them.
 * One home per fixture, so a fix has exactly one entry to remove.
 *
 * Asserted both ways: an unnamed column that is not here fails, and an entry here whose column is
 * named now fails too.
 */
const UNNAMED: Record<string, string> = {
  // No SQLiteBlobBuffer arm in the class-name path, and a bare `blob()` really is a buffer column
  // on 0.45.2. Both also carry a DEFECTS entry above, which is the relative half of the finding.
  // The one the comparison cannot see, and the reason this absolute check earns its place. The
  // analyzer names no type for a 0.4x mysqlEnum and prints "so its validator will accept any
  // value", and that sentence is false: every generator reads `enumValues` off the column
  // regardless of `tsType`, and the 0.4x zod output for this column is `z.enum(['a','b','c'])`.
  // So the emitted validator is right, the comparison above reports parity, and nothing but this
  // line records that the analyzer still cannot describe the column. Filed as addendum Z.
  // The nullable table's share of the same two gaps. Both are the same class as their `matrix`
  // twin, so listing them is the check that the gap is about the column class rather than about
  // `notNull`, which is the only thing that differs between the two.
  // Unnamed on both majors rather than on this one, and correctly so: a customType's JavaScript
  // type exists at compile time and nowhere else. It is here because this list is the absolute
  // record of what the analyzer cannot name, not of what it names differently per major.
  'sqlite/nullable.s_n_custom': 'a customType has no runtime shape to read; official emits an unknown for it too',
};

// Two tables per dialect, for the reason the v1 pass has two: every column of `matrix` is
// `notNull`, so until `nullable` arrived neither pass had compared a nullable column at all.
const DIALECTS = [
  {
    name: 'pg',
    tables: [
      {
        name: 'matrix',
        table: pgTable,
        mods: {
          zod: () => import('./src/gen-0-4x/pg/zod/matrix.zod.js'),
          valibot: () => import('./src/gen-0-4x/pg/valibot/matrix.valibot.js'),
          arktype: () => import('./src/gen-0-4x/pg/arktype/matrix.arktype.js'),
          typebox: () => import('./src/gen-0-4x/pg/typebox/matrix.typebox.js'),
        } as Record<string, () => Promise<any>>,
      },
      {
        name: 'nullable',
        table: pgNullable,
        mods: {
          zod: () => import('./src/gen-0-4x/pg/zod/nullable.zod.js'),
          valibot: () => import('./src/gen-0-4x/pg/valibot/nullable.valibot.js'),
          arktype: () => import('./src/gen-0-4x/pg/arktype/nullable.arktype.js'),
          typebox: () => import('./src/gen-0-4x/pg/typebox/nullable.typebox.js'),
        } as Record<string, () => Promise<any>>,
      },
    ],
  },
  {
    name: 'mysql',
    tables: [
      {
        name: 'matrix',
        table: myTable,
        mods: {
          zod: () => import('./src/gen-0-4x/mysql/zod/matrix.zod.js'),
          valibot: () => import('./src/gen-0-4x/mysql/valibot/matrix.valibot.js'),
          arktype: () => import('./src/gen-0-4x/mysql/arktype/matrix.arktype.js'),
          typebox: () => import('./src/gen-0-4x/mysql/typebox/matrix.typebox.js'),
        } as Record<string, () => Promise<any>>,
      },
      {
        name: 'nullable',
        table: myNullable,
        mods: {
          zod: () => import('./src/gen-0-4x/mysql/zod/nullable.zod.js'),
          valibot: () => import('./src/gen-0-4x/mysql/valibot/nullable.valibot.js'),
          arktype: () => import('./src/gen-0-4x/mysql/arktype/nullable.arktype.js'),
          typebox: () => import('./src/gen-0-4x/mysql/typebox/nullable.typebox.js'),
        } as Record<string, () => Promise<any>>,
      },
    ],
  },
  {
    name: 'sqlite',
    tables: [
      {
        name: 'matrix',
        table: sqTable,
        mods: {
          zod: () => import('./src/gen-0-4x/sqlite/zod/matrix.zod.js'),
          valibot: () => import('./src/gen-0-4x/sqlite/valibot/matrix.valibot.js'),
          arktype: () => import('./src/gen-0-4x/sqlite/arktype/matrix.arktype.js'),
          typebox: () => import('./src/gen-0-4x/sqlite/typebox/matrix.typebox.js'),
        } as Record<string, () => Promise<any>>,
      },
      {
        name: 'nullable',
        table: sqNullable,
        mods: {
          zod: () => import('./src/gen-0-4x/sqlite/zod/nullable.zod.js'),
          valibot: () => import('./src/gen-0-4x/sqlite/valibot/nullable.valibot.js'),
          arktype: () => import('./src/gen-0-4x/sqlite/arktype/nullable.arktype.js'),
          typebox: () => import('./src/gen-0-4x/sqlite/typebox/nullable.typebox.js'),
        } as Record<string, () => Promise<any>>,
      },
    ],
  },
];

const PREFIX: Record<string, string> = { select: 'Select', insert: 'Insert', update: 'Update' };

/**
 * Every column of every fixture, in every library and every mode: 39 + 17 Postgres, 28 + 12 MySQL
 * and 14 + 13 SQLite columns, `matrix` and `nullable`, times four libraries, times three modes.
 *
 * The Postgres numbers are one lower than the v1 pass on both tables, and for the same reason both
 * times: 0.45.2's pg-core has no `bytea` export, so `c_bytea` and `c_bytea_null` are both deleted
 * from this fixture by the edit above.
 *
 * Written out rather than derived from the arrays above, which would make it true by construction
 * and say nothing. It is the check that this stage cannot pass by comparing nothing, and it is not
 * a hypothetical failure: the cross-major stage this one sits beside spent a day comparing 0.45.2
 * against 0.45.2 and was green throughout. A fixture that grows a column fails here and has to be
 * re-measured, which is the intended cost.
 */
const EXPECTED_COMPARISONS = (39 + 17 + 30 + 12 + 14 + 13) * 4 * 3;

// Read off disk rather than through `require.resolve`, whose `exports` map has no `./package.json`
// entry for drizzle-orm. Reading it is also the point: this reports the version of the tree the
// run happened in rather than the version somebody believes was installed.
const version = (pkg: string): string => {
  const v = JSON.parse(readFileSync(`node_modules/${pkg}/package.json`, 'utf8')).version;
  if (typeof v !== 'string' || !v) {
    console.error(`    FAIL: ${pkg} reports no version, so this stage cannot say what it measured.`);
    process.exit(1);
  }
  return v;
};

// `npm init -y` leaves this project CommonJS, where tsx refuses a top-level await.
main().catch((e) => {
  console.error(e);
  process.exit(1);
});

async function main() {
  const drizzle = version('drizzle-orm');
  if (drizzle.split('.')[0] !== '0') {
    console.error(`    FAIL: this tree resolves drizzle-orm ${drizzle}, which is not the 0.4x line.`);
    console.error('          This stage exists because the parity pass near the top of this file');
    console.error('          measures v1 alone. Run against v1 it would measure it twice and pass.');
    process.exit(1);
  }
  const officials = LIB_NAMES.map((lib) => {
    const pkg = `drizzle-${lib}`;
    const v = version(pkg);
    // The 1.0.0 line of each of these targets drizzle-orm v1. Installed here it would either fail
    // to import or compare against the wrong major's rules, and either way the pin above moved
    // without anyone deciding to.
    if (v.split('.')[0] !== '0') {
      console.error(`    FAIL: ${pkg}@${v} is the v1 line, not the companion for drizzle-orm 0.4x.`);
      process.exit(1);
    }
    return `${pkg} ${v}`;
  });
  console.log(`    drizzle-orm ${drizzle} against ${officials.join(', ')}`);

  type Seen = {
    libs: Set<string>;
    modes: Set<string>;
    signatures: Map<string, string>;
    pairings: number;
    detail: string[];
  };
  const observed = new Map<string, Seen>();
  // `at` is every `<mode>/<value>` that actually crashed, so the printed figure is a count of
  // crashes rather than `modes.size * values.size`, which is the same number only while the
  // pattern is a rectangle. It is one today, and the assertion is on the sets either way.
  const crashed = new Map<string, { sides: Set<string>; modes: Set<string>; values: Set<string>; at: Set<string> }>();
  // DRZL's own verdict on a value official crashed on, keyed by crash site then `<mode>/<value>`.
  // The comparison cannot use it, which is not the same thing as nobody looking at it.
  const crashVerdict = new Map<string, Map<string, string>>();
  const recordCrashVerdict = (key: string, mode: string, label: string, verdict: Verdict) => {
    const seen = crashVerdict.get(key) ?? new Map<string, string>();
    seen.set(`${mode}/${label}`, verdict);
    crashVerdict.set(key, seen);
  };
  const recordCrash = (key: string, side: string, mode: string, value: string) => {
    const seen =
      crashed.get(key) ??
      { sides: new Set<string>(), modes: new Set<string>(), values: new Set<string>(), at: new Set<string>() };
    seen.sides.add(side);
    seen.modes.add(mode);
    seen.values.add(value);
    seen.at.add(`${side}/${mode}/${value}`);
    crashed.set(key, seen);
  };
  const findings: string[] = [];
  let totalCompared = 0;
  let pairings = 0;
  // The presence axis, counted apart from the value axis for the reason the v1 pass counts it
  // apart: one can go quiet while the other keeps reporting, and this is the one that was at zero.
  let presenceCompared = 0;
  let presenceCrashed = 0;
  let presenceUnreadable = 0;
  const usedBarren = new Set<string>();
  const usedSelectOptional = new Set<string>();
  const selectOptionalProblems: string[] = [];
  const selectSchemas = new Set<string>();
  let selectKeysInspected = 0;
  const presenceProblems: string[] = [];
  const presenceObserved = new Map<string, Seen>();
  const presenceThrew = new Map<string, { sides: Set<string>; modes: Set<string> }>();
  const recordPresenceCrash = (key: string, side: string, mode: string) => {
    const seen = presenceThrew.get(key) ?? { sides: new Set<string>(), modes: new Set<string>() };
    seen.sides.add(side);
    seen.modes.add(mode);
    presenceThrew.set(key, seen);
  };

  for (const d of DIALECTS) {
    for (const t of d.tables) {
    const loaded: Record<string, any> = {};
    for (const lib of LIB_NAMES) loaded[lib] = await t.mods[lib]();

    for (const mode of MODE_NAMES) {
      // Column names come from the official zod schema regardless of library: every module emits
      // the same set, and zod is the one whose shape is trivially enumerable. Built once per mode
      // rather than once per library, which was four builds of the same object.
      const oShape = OFFICIAL.zod[mode](t.table as never).shape;
      for (const libName of LIB_NAMES) {
        pairings++;
        const lib = LIBS[libName];
        const official = OFFICIAL[libName][mode](t.table as never);
        const mine = loaded[libName][`${PREFIX[mode]}${t.name}Schema`];
        if (!mine) {
          findings.push(`${d.name}/${libName}/${mode}: no ${PREFIX[mode]}${t.name}Schema exported`);
          continue;
        }
        const rows: string[] = [];
        let compared = 0;
        let ledgered = 0;

        for (const k of Object.keys(oShape)) {
          const o = safeField(lib, official, k);
          const m = safeField(lib, mine, k);
          if (!o && !m) {
            // Never a skip. Both sides absent means this column was measured by nothing, and
            // `safeField` returns undefined for a lookup that threw as well as for one that was
            // missing, so the quiet version of this branch reports parity on an exception.
            rows.push(`${k}: neither official nor DRZL yielded a field, so nothing was compared`);
            continue;
          }
          if (!m) { rows.push(`${k}: official has it, DRZL omits it`); continue; }
          if (!o) { rows.push(`${k}: DRZL has it, official omits it`); continue; }
          compared++;
          const looser: string[] = [];
          const tighter: string[] = [];
          // What official accepted, in pool order. Only read when DRZL accepted everything, where
          // it is the complement of the divergence and so names it exactly.
          const officialAccepted: string[] = [];
          let officialTook = false;
          let drzlTook = false;
          // Whether DRZL took the whole pool, which is what the derived signature rests on.
          let drzlAll = true;
          for (const [label, x] of POOL) {
            const a: Verdict = probe(lib, o, x);
            const b: Verdict = probe(lib, m, x);
            // A crash is not a verdict, so this value is not compared for this column. It goes to
            // the THREW list instead, which is asserted from both ends, so it can neither be
            // scored as the other side's answer nor vanish.
            if (a === 'threw' || b === 'threw') {
              if (a === 'threw') recordCrash(`${d.name}/${libName}/${k}`, 'official', mode, label);
              if (b === 'threw') recordCrash(`${d.name}/${libName}/${k}`, 'drzl', mode, label);
              // Not compared, and not unmeasured either: DRZL's answer is pinned against the crash
              // entry and arbitrated against a real database wherever one runs for this dialect.
              // Dropping it here and doing nothing else is what let a null-accepting insert schema
              // on a NOT NULL column sit under a green line on the other pass.
              recordCrashVerdict(`${d.name}/${libName}/${k}`, mode, label, b);
              continue;
            }
            if (a === 'accept') officialAccepted.push(label);
            officialTook ||= a === 'accept';
            drzlTook ||= b === 'accept';
            if (b !== 'accept') drzlAll = false;
            if (a !== b) (b === 'accept' ? looser : tighter).push(label);
          }
          // A column both sides reject every probe for agrees perfectly and proves nothing: the
          // two schemas could be a correct one and a broken one and this loop could not tell them
          // apart. Deliberately outside the ledger below, which says a difference is expected, not
          // that a column need not be measured.
          if (!officialTook && !drzlTook) {
            rows.push(
              `${k}: neither side accepts any pool value, so this column proves nothing.` +
                ' Add a value this column accepts to POOL.'
            );
            continue;
          }
          if (!looser.length && !tighter.length) continue;

          const key = `${d.name}/${k}`;
          const seen: Seen =
            observed.get(key) ??
            { libs: new Set(), modes: new Set(), signatures: new Map(), pairings: 0, detail: [] };
          seen.libs.add(libName);
          seen.modes.add(mode);
          seen.pairings++;
          seen.signatures.set(
            `${mode}/${libName}`,
            drzlAll
              ? allProbes(looser.length, officialAccepted)
              : `L: ${looser.join(', ')} | T: ${tighter.join(', ')}`
          );
          seen.detail.push(`${mode}/${libName} ${looser.length} looser ${tighter.length} tighter`);
          observed.set(key, seen);
          if (ALLOWED[key] || DEFECTS[key]) { ledgered++; continue; }
          rows.push(
            `${k}:` +
              (looser.length ? `\n          DRZL accepts, official rejects: ${looser.join(', ')}` : '') +
              (tighter.length ? `\n          DRZL rejects, official accepts: ${tighter.join(', ')}` : '')
          );
        }

        /**
         * The other axis: whether each side lets the key be missing.
         *
         * Kept apart from the pool loop above rather than folded in as one more probe, because an
         * absence is not a value and every signature in both ledgers is a list of values. Folding
         * it in would also move the `every probe official rejects` shorthand on every column
         * that carries it, which is a statement about what the two schemas do with the pool.
         */
        const oPres = askPresence(lib, official, Object.keys(oShape));
        const mPres = askPresence(lib, mine, Object.keys(oShape));
        const readSide = (r: typeof oPres, side: string) => {
          for (const k of r.barren) {
            const key = `${d.name}/${libName}/${k}`;
            if (PRESENCE_BARREN[key]) { usedBarren.add(key); continue; }
            presenceProblems.push(
              `${d.name}/${t.name}/${mode}/${libName} ${side} accepts no pool value for ${k}, so ` +
                'no object satisfying it can be built, and nothing declares that'
            );
          }
          if (r.control && !r.barren.length) {
            presenceProblems.push(`${d.name}/${t.name}/${mode}/${libName} ${side} ${r.control}`);
          }
        };
        readSide(oPres, 'official');
        readSide(mPres, 'DRZL');
        for (const k of oPres.crashed) recordPresenceCrash(`${d.name}/${libName}/${k}`, 'official', mode);
        for (const k of mPres.crashed) recordPresenceCrash(`${d.name}/${libName}/${k}`, 'drzl', mode);
        for (const k of Object.keys(oShape)) {
          const a = oPres.verdicts.get(k);
          const b = mPres.verdicts.get(k);
          // The absolute half, read off DRZL's side alone and before the two are compared. See the
          // note on SELECT_OPTIONAL: `pg/typebox/n_bit` reaches this line and reaches nothing else,
          // because official crashes on that omission rather than answering it.
          if (mode === 'select' && b) {
            // Counted where the check reads, so the two can never describe different sets.
            selectSchemas.add(`${d.name}/${t.name}/${libName}`);
            selectKeysInspected++;
            if (b === 'optional') {
              const abs = `${d.name}/${libName}/${k}`;
              if (SELECT_OPTIONAL[abs]) usedSelectOptional.add(abs);
              else selectOptionalProblems.push(`${abs}: DRZL's select schema lets this key be missing, and nothing declares it`);
            }
          }
          // Never a skip, and never silently: every column lands in exactly one of the three
          // counters, and the three have to add up to the pairing count further down.
          if (!a || !b) {
            if (oPres.crashed.includes(k) || mPres.crashed.includes(k)) presenceCrashed++;
            else presenceUnreadable++;
            continue;
          }
          presenceCompared++;
          if (a === b) continue;
          const key = `${d.name}/${k}`;
          const seen: Seen =
            presenceObserved.get(key) ??
            { libs: new Set(), modes: new Set(), signatures: new Map(), pairings: 0, detail: [] };
          seen.libs.add(libName);
          seen.modes.add(mode);
          seen.pairings++;
          seen.signatures.set(`${mode}/${libName}`, `official ${a}, DRZL ${b}`);
          seen.detail.push(`${mode}/${libName} official ${a} DRZL ${b}`);
          presenceObserved.set(key, seen);
          if (PRESENCE[key]) { ledgered++; continue; }
          rows.push(`${k}: the key is ${a} for official and ${b} for DRZL`);
        }

        // A run that compared no column at all would otherwise print `parity` and pass.
        if (compared === 0) {
          rows.push('no column was compared on both sides, so this pairing measured nothing');
        }
        totalCompared += compared;
        console.log(
          `    ${d.name.padEnd(7)} ${t.name.padEnd(8)} ${libName.padEnd(8)} ${mode.padEnd(7)} ` +
            `${compared}/${Object.keys(oShape).length} cols compared  ` +
            `${rows.length ? 'DIFFERS' : 'parity'}${ledgered ? ` (${ledgered} in the ledger)` : ''}`
        );
        if (rows.length) {
          for (const r of rows) console.log(`        ${r}`);
          findings.push(...rows.map((r) => `${d.name}/${libName}/${mode} ${r}`));
        }
      }
    }
    }
  }

  const filedAlready = Object.values(DEFECTS).filter((e) => e.filed.startsWith('AC:')).length;
  // As in the v1 pass: which side each waiver runs on, counted rather than asserted.
  const looserWaivers = Object.values(ALLOWED).filter((e) =>
    Object.values(e.divergence).some((s) => s.split('|')[0].replace(/^L:/, '').trim() !== '')
  ).length;
  console.log(`    ${totalCompared} column comparisons across ${pairings} pairings`);
  console.log(
    `    ${selectKeysInspected} select key(s) across ${selectSchemas.size} schema(s) required, bar ` +
      `${Object.keys(SELECT_OPTIONAL).length} declared to let the key go missing: ` +
      Object.keys(SELECT_OPTIONAL).join(', ')
  );
  console.log(
    `    ${presenceCompared} key-presence comparisons asked of the object rather than the field, ` +
      `${presenceCrashed} where a side crashed on the omission and ${presenceUnreadable} with no ` +
      `object to ask about (${Object.keys(PRESENCE_BARREN).join(', ')}); ` +
      `${Object.keys(PRESENCE).length} column(s) where the two disagree`
  );
  // Which columns use the rejection-count shorthand, and how many probes each of them stands for,
  // both read off the declarations. Sentences in the docstring block above used to write those
  // numbers down, and adding five pool values made every one of them wrong at once.
  const SHORTHAND = /^every probe official rejects \((\d+) of them\), and official accepts only: (.*)$/;
  const shorthand = [...Object.entries(ALLOWED), ...Object.entries(DEFECTS)].flatMap(([k, e]) =>
    Object.values(e.divergence)
      .map((d) => SHORTHAND.exec(d))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => ({
        key: k,
        rejected: Number(m[1]),
        accepted: m[2] === 'nothing in the pool' ? 0 : m[2].split(', ').length,
      }))
  );
  const shorthandCols = [...new Set(shorthand.map((x) => x.key))];
  console.log(
    `    ${Object.keys(ALLOWED).length} documented divergence(s), ${looserWaivers} of them with ` +
      `DRZL accepting something official refuses; ` +
      `${Object.keys(DEFECTS).length} known-defect column(s), ${filedAlready} already filed and ` +
      `${Object.keys(DEFECTS).length - filedAlready} first seen by this stage`
  );
  if (shorthand.length) {
    const span = (ns: number[]) => (Math.min(...ns) === Math.max(...ns) ? `${ns[0]}` : `${Math.min(...ns)} to ${Math.max(...ns)}`);
    console.log(
      `    ${shorthandCols.length} column(s) state their divergence as a rejection count and a ` +
        `complement: ${span(shorthand.map((x) => x.rejected))} rejections against ` +
        `${span(shorthand.map((x) => x.accepted))} label(s) named, which is why the shorthand exists`
    );
  }
  for (const [k, e] of Object.entries(DEFECTS)) {
    console.log(`      ${k}: DRZL emits ${e.drzl}, official emits ${e.official} [${e.filed}]`);
  }
  console.log(
    '    the json-schema generator is not in this comparison: there is no official 0.4x JSON' +
      ' Schema module to compare it against'
  );

  // Both directions. An entry that suppressed nothing describes something nobody can observe, and
  // an entry whose libraries or modes have moved is describing a different defect from the one
  // that is there now.
  const ledgerProblems: string[] = [];
  for (const [map, name, from] of [
    [ALLOWED, 'ALLOWED', observed],
    [DEFECTS, 'DEFECTS', observed],
    // Held to the identical rule, in the identical loop. Two ledgers side by side under different
    // rules is the state this stage was in for a round, and the weaker one absorbed a regression.
    [PRESENCE, 'PRESENCE', presenceObserved],
  ] as const) {
    for (const [key, entry] of Object.entries(map)) {
      const seen = from.get(key);
      if (!seen) {
        ledgerProblems.push(`${name}[${key}] suppressed nothing on this run`);
        continue;
      }
      const gotLibs = [...seen.libs].sort().join(',');
      const gotModes = [...seen.modes].sort().join(',');
      const wantLibs = [...entry.libs].sort().join(',');
      const wantModes = [...entry.modes].sort().join(',');
      if (gotLibs !== wantLibs) {
        ledgerProblems.push(`${name}[${key}] declares libs ${wantLibs}, measured ${gotLibs}`);
      }
      if (gotModes !== wantModes) {
        ledgerProblems.push(`${name}[${key}] declares modes ${wantModes}, measured ${gotModes}`);
      }
      const wantPairings = entry.libs.length * entry.modes.length - (entry.except?.length ?? 0);
      if (seen.pairings !== wantPairings) {
        ledgerProblems.push(
          `${name}[${key}] declares ${wantPairings} pairings, measured ${seen.pairings}: ` +
            seen.detail.join('; ')
        );
      }
      // The exact divergence, both ways. Every pairing has to be claimed by exactly one
      // declaration, and its signature has to match; every declaration has to claim at least one.
      const claimed = new Set<string>();
      for (const [pairing, sig] of seen.signatures) {
        const hits = Object.keys(entry.divergence).filter((d) => pairingMatches(d, pairing));
        if (hits.length !== 1) {
          ledgerProblems.push(
            `${name}[${key}] has ${hits.length} declarations for ${pairing}, needs exactly one. ` +
              `Measured there: ${sig}`
          );
          continue;
        }
        claimed.add(hits[0]);
        const want = entry.divergence[hits[0]];
        if (want === sig) continue;
        // One message for both signature forms. The shorthand had a branch of its own here while
        // it read `every probe official rejects` with no count and no complement, where printing
        // it against a measured `L: ...` list said nothing; it carries both now and reads the same
        // way round as any other signature, so the special case was byte identical to this one.
        ledgerProblems.push(
          `${name}[${key}] on ${pairing} declares\n        ${want}\n      and measured\n        ${sig}`
        );
      }
      for (const d of Object.keys(entry.divergence)) {
        if (!claimed.has(d)) ledgerProblems.push(`${name}[${key}] declaration '${d}' matched no pairing`);
      }
    }
  }
  // Each entry carries its own measured detail, because the two maps it is drawn from are keyed
  // the same way and a lookup in the wrong one reads as undefined. It did: the first version built
  // bare keys and printed `observed.get(k)!.detail`, which threw on a presence-only key and turned
  // a reportable finding into a stack trace.
  const unledgered = [
    ...[...observed.entries()]
      .filter(([k]) => !ALLOWED[k] && !DEFECTS[k])
      .map(([k, seen]) => `${k}: ${seen.detail.join('; ')}`),
    ...[...presenceObserved.entries()]
      .filter(([k]) => !PRESENCE[k])
      .map(([k, seen]) => `${k} (key presence): ${seen.detail.join('; ')}`),
  ];

  // The presence axis, held to the same denominator as the value axis, and to the same THREW
  // ledger for the omissions official crashes on rather than answers.
  if (presenceCompared + presenceCrashed + presenceUnreadable !== EXPECTED_COMPARISONS) {
    presenceProblems.push(
      `${presenceCompared} key-presence comparisons plus ${presenceCrashed} crashed and ` +
        `${presenceUnreadable} unreadable, which is not the ${EXPECTED_COMPARISONS} column ` +
        'pairings the value pool is pushed through'
    );
  }
  for (const key of Object.keys(PRESENCE_BARREN)) {
    if (!usedBarren.has(key)) {
      presenceProblems.push(`PRESENCE_BARREN[${key}] names a column that accepts a pool value now, so delete it`);
    }
  }
  for (const key of Object.keys(SELECT_OPTIONAL)) {
    if (!usedSelectOptional.has(key)) {
      selectOptionalProblems.push(`SELECT_OPTIONAL[${key}] requires its key on select now, so delete it`);
    }
  }
  if (selectSchemas.size !== SELECT_REACH.schemas || selectKeysInspected !== SELECT_REACH.keys) {
    selectOptionalProblems.push(
      `the select check read ${selectSchemas.size} schema(s) and ${selectKeysInspected} key(s), ` +
        `declared ${SELECT_REACH.schemas} and ${SELECT_REACH.keys}. It has no second side to ` +
        'disagree with it, so a shrinking reach is silent unless this fails'
    );
  }
  for (const [key, seen] of presenceThrew) {
    const e = THREW[key];
    if (!e) {
      presenceProblems.push(
        `${key}: ${[...seen.sides].sort().join('/')} crashed on the object with the key omitted ` +
          `in ${[...seen.modes].sort().join(', ')}, and is in no list`
      );
      continue;
    }
    const gotSides = [...seen.sides].sort().join(',');
    if (gotSides !== e.side) {
      presenceProblems.push(`THREW[${key}] declares side ${e.side}, and the omission crashed on ${gotSides}`);
    }
    const gotModes = [...seen.modes].sort().join(',');
    const wantModes = [...e.absentModes].sort().join(',');
    if (gotModes !== wantModes) {
      presenceProblems.push(`THREW[${key}] declares absentModes ${wantModes || 'none'}, measured ${gotModes}`);
    }
  }
  for (const [key, e] of Object.entries(THREW)) {
    if (e.absentModes.length && !presenceThrew.has(key)) {
      presenceProblems.push(
        `THREW[${key}] declares absentModes ${e.absentModes.join(',')} and no omission crashed there`
      );
    }
  }

  /**
   * The MySQL text caps, bracketed rather than stepped past.
   *
   * Two probes per column, not one. One string over the cap only ever proves the cap is below it,
   * so the single probe this replaced pinned `tinytext` to the interval [36, 257] rather than to
   * 255: 36 is the largest pool string under the cap and 257 is where a probe built out of
   * three-byte characters lands. Measured rather than reasoned, by moving the emitted cap and
   * re-running: 257 and 36 both left the run byte identical to green, 258 and 35 both failed it.
   * The same construction left `text` free over [400, 65537] and `mediumtext` over about 16.7
   * million values.
   *
   * The pair brackets it. `floor(cap/3)` three-byte characters plus `cap mod 3` ASCII ones is
   * exactly `cap` bytes and roughly a third of that in UTF-16 units, so DRZL has to take it; one
   * more ASCII character is exactly `cap + 1` bytes, so DRZL has to refuse it. Both stay far under
   * any character cap, so neither is answering a question about characters, and together they pin
   * the byte cap to a single value.
   *
   * A real MySQL 8.4.11 on a utf8mb4 client agrees with both halves, which is what makes them the
   * right expectations rather than today's behaviour written down: for `tinytext`, `text` and
   * `mediumtext` alike, the at-cap string inserts and `octet_length` reads back exactly the cap,
   * while the one-byte-longer string fails with ERROR 1406 "Data too long".
   *
   * Both strings are derived from each column's own cap rather than written down, so a cap that
   * moves moves the pair with it.
   */
  // Read off the runtime rather than written down, so a V8 with a different limit is described
  // correctly instead of being asserted about.
  const MAX_JS_STRING = constants.MAX_STRING_LENGTH;
  const TEXT_CAPS: Record<string, number> = {
    m_tinytext: 255,
    m_text: 65535,
    m_mediumtext: 16777215,
    m_longtext: 4294967295,
  };

  /**
   * Where each MySQL text column's byte cap is actually measured.
   *
   * Computed by this run and compared with the declaration in both directions, because a sentence
   * about who measures what is exactly the kind that goes quietly false. Two of them already have
   * on this branch, and the second was introduced by the fix for the first. `m_longtext` is
   * measured by nothing at all, and deleting every one of its caps from all four generated modules
   * in all three modes leaves both passes byte identical to green.
   *
   * The two things that measure a cap do not measure the same amount of it, and the printed line
   * used to give each of them one word, so `the pool and the byte-cap stage` read as two
   * measurements of the cap when only one of them is. They are named apart now:
   *
   *   `separated`  the pool holds a string this column's byte cap refuses and its UTF-16 count does
   *                not, which is the only kind of string the comparison above can tell the two
   *                counts apart with. It does not pin the cap: moving `m_tinytext`'s emitted cap to
   *                254 or to 256 produces no failure from the pool at all.
   *   `bracketed`  the pair below was built and pushed through, at the cap and one byte over, which
   *                does pin the cap to a single value.
   */
  const CAP_COVERAGE: Record<string, string> = {
    m_tinytext: 'bracketed and separated',
    m_text: 'bracketed and separated',
    m_mediumtext: 'bracketed only',
    m_longtext: 'neither',
  };

  const capProblems: string[] = [];
  const capMeasured: string[] = [];
  const capUnreachable: string[] = [];
  {
    // The `matrix` table by name: `m_tinytext` and its siblings live there, and `nullable` carries
    // its own `m_n_tinytext` with its own cap.
    const mysqlMatrix = DIALECTS.find((d) => d.name === 'mysql')?.tables.find((t) => t.name === 'matrix');
    if (!mysqlMatrix) {
      capProblems.push('the MySQL matrix table is not in this stage, so no byte cap was measured');
    } else {
      const loaded: Record<string, any> = {};
      for (const lib of LIB_NAMES) loaded[lib] = await mysqlMatrix.mods[lib]();
      for (const [col, cap] of Object.entries(TEXT_CAPS)) {
        const wide = Math.floor(cap / 3);
        const rest = cap - wide * 3;
        const units = wide + rest;
        if (units + 1 > MAX_JS_STRING) {
          capUnreachable.push(`${col} (a probe needs ${units + 1} units, over this V8's ${MAX_JS_STRING})`);
          // UTF-8 spends at most 3 bytes per UTF-16 unit, checked over every code point, so no JS
          // string here can carry more than this many bytes. When that is under the cap the cap
          // cannot be exceeded at all, which is stronger than this construction being too long,
          // and it is the state `longtext` is in. Anything else means some other construction
          // reaches the column and this list is hiding it.
          if (MAX_JS_STRING * 3 >= cap) {
            capProblems.push(
              `${col} is listed as unprobeable, but a JS string here can carry ${MAX_JS_STRING * 3} ` +
                `bytes, which is over its ${cap} byte cap. Some construction reaches it and this one does not.`
            );
          }
          continue;
        }
        const atCap = '\u4E00'.repeat(wide) + 'x'.repeat(rest);
        const overCap = `${atCap}x`;
        for (const mode of MODE_NAMES) {
          for (const libName of LIB_NAMES) {
            const lib = LIBS[libName];
            const o = safeField(lib, OFFICIAL[libName][mode](mysqlMatrix.table as never), col);
            const m = safeField(lib, loaded[libName][`${PREFIX[mode]}matrixSchema`], col);
            if (!o || !m) {
              capProblems.push(`${col} has no field on ${mode}/${libName}, so no cap was measured`);
              continue;
            }
            const at = { o: probe(lib, o, atCap), m: probe(lib, m, atCap) };
            const over = { o: probe(lib, o, overCap), m: probe(lib, m, overCap) };
            capMeasured.push(`${col}/${mode}/${libName}/at`, `${col}/${mode}/${libName}/over`);
            // Today's state and the only one that is not a finding, on both halves. Official counts
            // UTF-16 units, so it takes both. DRZL counts bytes, so the cap is where MySQL puts it:
            // `cap` bytes in, `cap + 1` bytes out.
            if (at.o === 'accept' && at.m === 'accept' && over.o === 'accept' && over.m === 'reject') continue;
            capProblems.push(
              `${col} on ${mode}/${libName}: at ${cap} bytes (${units} units) official ${at.o}, ` +
                `DRZL ${at.m}; at ${cap + 1} bytes (${units + 1} units) official ${over.o}, ` +
                `DRZL ${over.m}. Expected both accepted and DRZL alone refusing the second, which ` +
                'is where MySQL 8.4.11 puts the boundary.'
            );
          }
        }
      }
    }
  }
  if (!capMeasured.length) capProblems.push('no MySQL text column had its byte cap measured');

  // The coverage claim, computed rather than asserted in a comment nobody re-runs.
  const poolSeparates = (cap: number) =>
    POOL.some(([, x]) => typeof x === 'string' && Buffer.byteLength(x, 'utf8') > cap && x.length <= cap);
  const coverageSeen: string[] = [];
  for (const [col, cap] of Object.entries(TEXT_CAPS)) {
    const byPool = poolSeparates(cap);
    const byStage = capMeasured.some((probed) => probed.startsWith(`${col}/`));
    const got = byPool && byStage
      ? 'bracketed and separated'
      : byPool
        ? 'separated only'
        : byStage
          ? 'bracketed only'
          : 'neither';
    coverageSeen.push(`${col} ${got}`);
    if (CAP_COVERAGE[col] === got) continue;
    capProblems.push(
      `${col} is declared '${CAP_COVERAGE[col] ?? 'nothing, being absent from CAP_COVERAGE'}'` +
        `, and this run measured '${got}'`
    );
  }
  for (const col of Object.keys(CAP_COVERAGE)) {
    if (col in TEXT_CAPS) continue;
    capProblems.push(`CAP_COVERAGE names ${col}, which has no cap in TEXT_CAPS, so it describes nothing`);
  }

  console.log(
    `    ${capMeasured.length} byte-cap probe(s) bracketing ${Object.keys(TEXT_CAPS).length - capUnreachable.length} ` +
      `MySQL text column(s); ${capUnreachable.length} cannot be probed at all: ${capUnreachable.join(', ')}`
  );
  console.log(
    "    byte caps: 'bracketed' is probed at the cap and one byte over, which pins DRZL's cap to" +
      " one value; 'separated' is the pool holding a string the cap refuses on bytes and takes on" +
      ' characters, which tells the two counts apart without pinning the cap'
  );
  console.log(`    ${coverageSeen.join('; ')}`);

  // The absolute half: what the analyzer makes of these two fixtures on its own.
  const unnamedProblems: string[] = [];
  const unnamedSeen = new Set<string>();
  let analyzed = 0;
  for (const [dialect, file] of [['mysql', 'src/matrix-mysql.ts'], ['sqlite', 'src/matrix-sqlite.ts']]) {
    const a = await new SchemaAnalyzer(file).analyze({});
    const failed = a.issues.filter((i) => i.code === 'DRZL_ANL_IMPORT');
    if (failed.length) {
      unnamedProblems.push(`${file} could not be imported: ${failed.map((i) => i.message).join('; ')}`);
      continue;
    }
    for (const t of a.tables) {
      for (const c of t.columns) {
        analyzed++;
        if (c.tsType !== 'unknown' && c.dbType !== 'UNKNOWN') continue;
        const key = `${dialect}/${t.name}.${c.name}`;
        if (UNNAMED[key]) { unnamedSeen.add(key); continue; }
        unnamedProblems.push(`${key} is analyzed as unknown on 0.4x and is in no list`);
      }
    }
  }
  // A run that analyzed nothing would otherwise report every entry as dead and read as a fix.
  if (!analyzed) unnamedProblems.push('no column was analyzed from the MySQL or SQLite fixture');
  for (const key of Object.keys(UNNAMED)) {
    if (!unnamedSeen.has(key)) {
      unnamedProblems.push(`UNNAMED[${key}] is named on 0.4x now, so delete it here and in DEFECTS`);
    }
  }
  console.log(
    `    ${analyzed} columns analyzed on 0.4x across the MySQL and SQLite fixtures, ` +
      `${unnamedSeen.size} unnamed and filed`
  );

  // The crashes, held to the same rule from both ends as everything else here.
  const crashProblems: string[] = [];
  for (const [key, seen] of crashed) {
    const e = THREW[key];
    if (!e) {
      crashProblems.push(
        `${key}: ${[...seen.sides].sort().join('/')} crashed on ` +
          `${[...seen.values].sort().join(', ')} in ${[...seen.modes].sort().join(', ')}, ` +
          'and is in no list'
      );
      continue;
    }
    const got: Record<string, string> = {
      side: [...seen.sides].sort().join(','),
      modes: [...seen.modes].sort().join(','),
      values: [...seen.values].sort().join(','),
    };
    const want: Record<string, string> = {
      side: e.side,
      modes: [...e.modes].sort().join(','),
      values: [...e.values].sort().join(','),
    };
    for (const f of ['side', 'modes', 'values']) {
      if (got[f] !== want[f]) crashProblems.push(`THREW[${key}] declares ${f} ${want[f]}, measured ${got[f]}`);
    }
  }
  for (const key of Object.keys(THREW)) {
    if (!crashed.has(key)) crashProblems.push(`THREW[${key}] saw no crash on this run`);
  }

  /**
   * What DRZL answered where official could not, held to the declaration in both directions.
   *
   * Without this a crashing official validator is a licence for DRZL to do anything on that value.
   * `c_bit` is `bit({ dimensions: 3 }).notNull()`, and on the v1 pass its Insert and Update schemas
   * were made to accept `null` with that pass staying byte identical to green.
   */
  const declMatches = (decl: string, mode: string, label: string) => {
    const cut = decl.indexOf('/');
    return (decl.slice(0, cut) === '*' || decl.slice(0, cut) === mode) && decl.slice(cut + 1) === label;
  };
  for (const [key, seen] of crashVerdict) {
    const e = THREW[key];
    // An undeclared crash is already a failure above; reporting the same site twice adds nothing.
    if (!e) continue;
    const want = e.modes.length * e.values.length;
    if (seen.size !== want) {
      crashProblems.push(
        `THREW[${key}] declares ${want} crashed probe(s), measured ${seen.size}: ${[...seen.keys()].sort().join(', ')}`
      );
    }
    const claimed = new Set<string>();
    for (const [at, verdict] of seen) {
      const cut = at.indexOf('/');
      const hits = Object.keys(e.drzl).filter((decl) => declMatches(decl, at.slice(0, cut), at.slice(cut + 1)));
      if (hits.length !== 1) {
        crashProblems.push(`THREW[${key}].drzl has ${hits.length} declarations for ${at}, needs exactly one. Measured there: ${verdict}`);
        continue;
      }
      claimed.add(hits[0]);
      if (e.drzl[hits[0]] === verdict) continue;
      crashProblems.push(`THREW[${key}].drzl declares ${e.drzl[hits[0]]} on ${at}, measured ${verdict}`);
    }
    for (const decl of Object.keys(e.drzl)) {
      if (!claimed.has(decl)) crashProblems.push(`THREW[${key}].drzl declaration '${decl}' matched no crashed probe`);
    }
  }

  /**
   * And what says those answers are the right ones.
   *
   * A pinned verdict stops DRZL's behaviour moving unseen; it does not say the pinned value is
   * correct, and on this major it is not: the analyzer cannot name `c_bit`, so DRZL takes a NULL
   * for a NOT NULL column, and takes that column being left out of an insert too. A real Postgres
   * is what says so. The table is built from the fixture column's own `getSQLType()`, the nullable
   * twin has to take a NULL before the NOT NULL twin's refusal counts as anything, and the twin
   * carrying a default has to take an omission while still refusing a NULL before the omission's
   * refusal is read as an answer about the omission.
   *
   * Every probe on this pass is arbitrated, so nothing here rests on a reason for not arbitrating.
   * The one this pass can still produce, a dialect with no engine in this process, is checked
   * against the engine's own `select version()` rather than against the branch that writes it.
   */
  const arbiterProblems: string[] = [];
  {
    // Both Postgres tables, so a crash site on a `nullable` column reaches the same database.
    const pgColumns = [pgTable, pgNullable].flatMap(
      (t) => getTableConfig(t as never).columns as { name: string; notNull: boolean; getSQLType: () => string }[]
    );
    const wanted: { key: string; label: string; value: unknown; dialect: string; column: string }[] = [];
    for (const [key, e] of Object.entries(THREW)) {
      const [dialect, , column] = key.split('/');
      const declared = Object.keys(e.arbiter).sort().join(',');
      const values = [...e.values].sort().join(',');
      if (declared !== values) {
        arbiterProblems.push(`THREW[${key}].arbiter covers ${declared || 'nothing'}, and the crash values are ${values}`);
      }
      for (const label of e.values) {
        const found = POOL.find(([l]) => l === label);
        if (!found) {
          arbiterProblems.push(`THREW[${key}] names the value ${label}, which is not in POOL, so nothing can be asked about it`);
          continue;
        }
        wanted.push({ key, label, value: found[1], dialect, column });
      }
    }
    const probes: DbProbe[] = [];
    for (const w of wanted) {
      if (w.dialect !== 'pg') continue;
      const col = pgColumns.find((c) => c.name === w.column);
      if (!col) {
        arbiterProblems.push(`THREW[${w.key}] names a column the Postgres fixture does not have, so no DDL can be built for it`);
        continue;
      }
      // The pool's `undefined` is an absence and is carried to the database as one: the statement
      // never names the column, rather than binding a NULL where it would have gone.
      probes.push({
        key: w.key,
        sqlType: col.getSQLType(),
        notNull: col.notNull,
        label: w.label,
        absent: w.value === undefined,
        value: w.value,
      });
    }
    const { engine, answers } = await askPostgres(probes);
    // A run where the database answered nothing would otherwise leave every site reading as
    // deliberately unarbitrated.
    if (!probes.length) arbiterProblems.push('no crash site reached a database on this run, so nothing was arbitrated');
    if (engine !== 'pg') {
      arbiterProblems.push(`the in-process engine answers 'select version()' with ${engine}, and every answer below is read as a Postgres one`);
    }
    let arbitrated = 0;
    for (const w of wanted) {
      const e = THREW[w.key];
      const verdicts = [...new Set(
        [...(crashVerdict.get(w.key) ?? new Map<string, string>())]
          .filter(([at]) => at.slice(at.indexOf('/') + 1) === w.label)
          .map(([, v]) => v)
      )].sort();
      let got: string;
      if (w.dialect !== 'pg') {
        got = `no in-process ${w.dialect} engine`;
        // Asserted rather than only computed, against the engine's own name for itself.
        if (engine === w.dialect) {
          arbiterProblems.push(
            `${w.key}/${w.label} is declared unarbitrable for want of a ${w.dialect} engine, and the ` +
              `engine in this process names itself ${engine}`
          );
        }
      } else {
        const a = answers.get(`${w.key}/${w.label}`);
        if (!a) {
          arbiterProblems.push(`${w.key}/${w.label} was sent to the database and came back with no answer`);
          continue;
        }
        if (a.control) {
          arbiterProblems.push(`${w.key}/${w.label}: ${a.control}`);
          continue;
        }
        arbitrated++;
        const asked = w.value === undefined ? 'the column omitted from the insert' : 'it';
        got = a.verdict === 'accept' ? `postgres accepts ${asked}` : `postgres refuses ${asked} (SQLSTATE ${a.code})`;
        // The one rule the declaration cannot talk its way out of. A value the database refuses and
        // DRZL takes is a schema admitting a row the server will not, and it is only not a failure
        // here because the ledger already names it as a defect. Named or not, the run says which
        // probe it was and which map covered it: a defect that is filed is still a defect, and a
        // ledger entry is not a reason to print nothing. `ALLOWED` and `DEFECTS` are read
        // dialect-wide. On this pass that is the shape of the lookup rather than a live guard,
        // since every key here is built as `${dialect}/${column}` and no waiver is library-scoped;
        // the v1 copy of this check is where it does work, and is proven both ways there.
        if (a.verdict === 'refuse' && verdicts.includes('accept')) {
          const named = ALLOWED[`${w.dialect}/${w.column}`]
            ? 'ALLOWED'
            : DEFECTS[`${w.dialect}/${w.column}`]
              ? 'DEFECTS'
              : '';
          if (named) {
            console.log(
              `    ${w.key}/${w.label}: postgres refuses ${asked} and DRZL accepts it, filed as ` +
                `${named}[${w.dialect}/${w.column}] rather than failed here`
            );
          } else {
            arbiterProblems.push(
              `${w.key}/${w.label}: postgres refuses ${asked} and DRZL accepts it, and neither map names ` +
                `${w.dialect}/${w.column}`
            );
          }
        }
      }
      if (e.arbiter[w.label] === got) continue;
      arbiterProblems.push(`THREW[${w.key}].arbiter declares '${e.arbiter[w.label]}' for ${w.label}, and this run got '${got}'`);
    }
    console.log(
      `    ${arbitrated} crash probe(s) arbitrated against a real Postgres, of ` +
        `${wanted.length} across ${Object.keys(THREW).length} crash site(s)`
    );
  }

  const crashCount = [...crashed.values()].reduce((n, c) => n + c.at.size, 0);
  console.log(
    `    ${crashCount} probe(s) crashed instead of returning a verdict, on ${crashed.size} ` +
      `column(s) against ${Object.keys(THREW).length} declared, compared as neither accept nor ` +
      "reject, and DRZL's own verdict on each pinned above"
  );

  if (unledgered.length) {
    console.error('    FAIL: these columns differ from the official 0.4x module and are in neither');
    console.error('          map. A difference that is deliberate goes in ALLOWED with its reason,');
    console.error('          and one that is a DRZL defect goes in DEFECTS naming what it is:');
    for (const k of unledgered) console.error(`      ${k}`);
  }
  if (ledgerProblems.length) {
    console.error('    FAIL: the ledger no longer describes this run. If a defect was fixed, delete');
    console.error('          its entry; if it moved, re-measure it. An entry left behind is a');
    console.error('          sentence about something nobody can observe:');
    for (const p of ledgerProblems) console.error(`      ${p}`);
  }
  if (totalCompared !== EXPECTED_COMPARISONS) {
    const direction = totalCompared < EXPECTED_COMPARISONS ? 'fewer' : 'more';
    console.error(`    FAIL: ${totalCompared} column comparisons, expected ${EXPECTED_COMPARISONS}.`);
    console.error(`          This run compared ${direction} columns than EXPECTED_COMPARISONS says.`);
    if (totalCompared < EXPECTED_COMPARISONS) {
      console.error('          A parity pass that measures fewer columns than it did yesterday is');
      console.error('          the failure this file has been bitten by most, so this is a stop.');
      console.error('          Find what stopped being compared before touching the constant.');
    } else {
      console.error('          A fixture grew. That is fine and it is not automatic: measure the');
      console.error('          new columns, put any difference in ALLOWED or DEFECTS with its');
      console.error('          reason, and then update EXPECTED_COMPARISONS in this file to match.');
    }
  }
  if (crashProblems.length) {
    console.error('    FAIL: a probe crashed where the THREW list does not say one does, or a');
    console.error('          declared crash stopped happening, or DRZL answered something else');
    console.error('          where it did. A crash is not a verdict and must not be compared as');
    console.error('          one, and it is not a reason to stop measuring DRZL either:');
    for (const c of crashProblems) console.error(`      ${c}`);
  }
  if (arbiterProblems.length) {
    console.error('    FAIL: a crash site is no longer settled the way it is declared to be. A');
    console.error('          value official crashes on is still a value DRZL answers, and');
    console.error('          something has to say whether that answer is right:');
    for (const a of arbiterProblems) console.error(`      ${a}`);
  }
  if (unnamedProblems.length) {
    console.error('    FAIL: the unnamed-column list does not describe this run:');
    for (const u of unnamedProblems) console.error(`      ${u}`);
  }
  if (capProblems.length) {
    console.error('    FAIL: a MySQL text column no longer separates a byte budget from a');
    console.error('          character count the way it is documented to:');
    for (const c of capProblems) console.error(`      ${c}`);
  }
  if (findings.length) {
    console.error(`    FAIL: ${findings.length} parity finding(s): a generated schema differs from`);
    console.error('          the first-party module on a value, and no waiver names that');
    console.error('          difference. Looser is not automatically wrong, which is what this');
    console.error('          sentence used to claim. Ask the database which side is right, then');
    console.error('          put the answer in ALLOWED with its measurement, or fix the generator.');
  }
  if (selectOptionalProblems.length) {
    console.error('    FAIL: a select schema lets a key go missing. A select row carries every');
    console.error('          column, so an optional key there is wrong however many libraries agree');
    console.error('          about it:');
    for (const p of selectOptionalProblems) console.error(`      ${p}`);
  }
  if (presenceProblems.length) {
    console.error('    FAIL: the key-presence axis could not measure what it claims to. A column no');
    console.error('          side accepts a value for, an object a side refuses despite being built');
    console.error('          from its own accepted values, and an omission a side crashes on are');
    console.error('          none of them readings, and must not be compared as ones:');
    for (const p of presenceProblems) console.error(`      ${p}`);
  }
  if (
    findings.length ||
    ledgerProblems.length ||
    unledgered.length ||
    crashProblems.length ||
    arbiterProblems.length ||
    unnamedProblems.length ||
    capProblems.length ||
    presenceProblems.length ||
    selectOptionalProblems.length ||
    totalCompared !== EXPECTED_COMPARISONS
  ) {
    process.exit(1);
  }
}
