/**
 * Differential parity for DRZL's validator generators.
 *
 * Pass 1 compares DRZL against `drizzle-orm/{zod,valibot,arktype}` for every column of every
 * table, across three dialects and all three schema modes, by pushing the same pool of values
 * through both and comparing verdicts. Reading the emitted source cannot do this: a schema that
 * validates and one that merely parses look identical as text.
 *
 * Pass 2 cross-checks DRZL's own four generators against each other, which catches a generator
 * drifting from its siblings on something all four should agree about.
 *
 * Both passes here measure drizzle-orm v1, which is what this tree pins. The same comparison
 * against the first-party modules for 0.45.2 runs near the end of this gate, in the 0.4x tree,
 * and reads its pool of values out of the same `pool.ts` this file does.
 *
 * All four are compared against official. `drizzle-orm/typebox` targets the newer `typebox`
 * package and throws `Class extends value undefined` on import against the released one, but
 * `drizzle-orm/typebox-legacy` is the same module built for `@sinclair/typebox`, which is what
 * this generator emits for.
 */
import { createSelectSchema, createInsertSchema, createUpdateSchema } from 'drizzle-orm/zod';
import {
  createSelectSchema as vSelect,
  createInsertSchema as vInsert,
  createUpdateSchema as vUpdate,
} from 'drizzle-orm/valibot';
import {
  createSelectSchema as aSelect,
  createInsertSchema as aInsert,
  createUpdateSchema as aUpdate,
} from 'drizzle-orm/arktype';
import {
  createSelectSchema as tSelect,
  createInsertSchema as tInsert,
  createUpdateSchema as tUpdate,
} from 'drizzle-orm/typebox-legacy';
// The pool and the accessors come from a file the 0.4x pass reads as well, so both majors are
// asked the same question with the same values.
import { readFileSync } from 'node:fs';
import { constants } from 'node:buffer';
import { getTableConfig } from 'drizzle-orm/pg-core';
import {
  POOL,
  LIBS,
  probe,
  askPostgres,
  askPresence,
  type DbProbe,
  type Lib,
  type Verdict,
} from './pool.js';

import { matrix as pgTable, nullable as pgNullable } from './schema.js';
import { matrix as myTable, nullable as myNullable } from './schema-mysql.js';
import { matrix as sqTable, nullable as sqNullable } from './schema-sqlite.js';

const OFFICIAL: Record<string, Record<string, (t: any) => any>> = {
  zod: { select: createSelectSchema, insert: createInsertSchema, update: createUpdateSchema },
  valibot: { select: vSelect, insert: vInsert, update: vUpdate },
  arktype: { select: aSelect, insert: aInsert, update: aUpdate },
  // `drizzle-orm/typebox` targets the `typebox` package and throws on import against the released
  // one, but `typebox-legacy` is the same module built for `@sinclair/typebox`, which is what
  // this generator emits for. So typebox is compared against official like the other three
  // rather than only cross-checked.
  typebox: { select: tSelect, insert: tInsert, update: tUpdate },
};

const safeField = (lib: Lib, s: any, k: string) => {
  try {
    return lib.field(s, k);
  } catch {
    return undefined;
  }
};

/**
 * Probes where one side crashes instead of answering, which is not a verdict and is not compared
 * as one. Declared exactly, and asserted in both directions like every other list here: an
 * undeclared crash fails this script, and a declared one that no longer happens fails it too.
 *
 * A crash used to end the story for that value: it was dropped from the comparison, so nothing
 * measured DRZL on it at all. That made a crashing official module a licence for DRZL to do
 * anything. Demonstrated rather than feared: making the typebox Insert and Update schemas for
 * `c_bit` accept `null`, on a `bit(3).notNull()` column, left this whole run byte identical to
 * green. Doing it to the Select arm as well is caught at once, by the cross-generator pass below
 * printing `c_bit on null: typebox accept, zod/valibot/arktype reject`, and that is the whole of
 * the old coverage: that pass reads `SelectmatrixSchema` and nothing else.
 *
 * So two more fields, and both are asserted:
 *
 *   `drzl`     what DRZL answers on the crashed value, keyed `<mode-or-*>/<value>`. Every crashed
 *              probe has to be claimed by exactly one declaration and match it, and every
 *              declaration has to claim at least one probe. This is the part that fails when
 *              DRZL's answer moves.
 *   `arbiter`  who settles that DRZL's answer is the right one, keyed by value, and computed by
 *              the run rather than believed: a real Postgres through PGlite wherever one runs for
 *              that dialect, and the reason it cannot be otherwise. A value the database refuses
 *              and DRZL accepts is a finding unless a waiver names the column dialect-wide, as
 *              `<dialect>/<column>`. A library-scoped waiver such as `pg/typebox/c_uuid` does not
 *              suppress it, which is the fail-closed direction: the database's answer does not
 *              depend on which library was asked, so a waiver about one library is not a reason to
 *              accept a row the server will reject.
 *
 * Keyed `<dialect>/<library>/<column>`.
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
   * reporting the key missing. Empty where that does not happen, and asserted in both directions
   * like everything else here, so a crash the presence axis meets is either declared or a failure.
   */
  absentModes: string[];
};
const THREW: Record<string, Crash> = {
  // Three columns, one cause, and the set is derived rather than collected: official's TypeBox
  // module emits `{ type: 'RegExp', maxLength }` for exactly these three on this major, and
  // TypeBox's length check reads `value.length` with no type guard. Enumerating the `type: RegExp`
  // columns and the crashing columns across all three dialects and all three modes gives the same
  // nine pairings. `drizzle-typebox 0.3.3` on 0.45.2 has the same defect on `c_bit`, and emits a
  // bare string for the two binary columns, so the 0.4x pass declares one site and not three.
  // Nothing DRZL emits crashes on any probe, on either major.
  'pg/typebox/c_bit': {
    side: 'official',
    modes: ['select', 'insert', 'update'],
    values: ['null', 'undefined'],
    why: 'official Type.RegExp with maxLength reads .length of a null value',
    drzl: { '*/null': 'reject', '*/undefined': 'reject' },
    arbiter: {
      // A real Postgres, built from this column's own `getSQLType()`, refuses a NULL into
      // `bit(3) not null` with a not-null violation, and its nullable twin takes one.
      null: 'postgres refuses it (SQLSTATE 23502)',
      // An absence is handed to a database by leaving the column out of the insert, so this is
      // asked rather than declared unaskable. What used to stand here said no database could be
      // handed an absence, on the evidence that a bound `undefined` comes back 23502; that is a
      // fact about the driver's parameter binding, and it was written up as one about databases.
      // Measured on this column's own `bit(3) not null`: the insert that never names `c` is
      // refused 23502, while the same omission against a twin of the same type carrying a default
      // is accepted and stores the default, and that twin still refuses an explicit NULL. Three
      // questions, three answers, and this entry is the answer to the middle one.
      undefined: 'postgres refuses the column omitted from the insert (SQLSTATE 23502)',
    },
    // No omission ever reaches this column: `c_uuid` on the same object accepts nothing, so
    // official's Postgres TypeBox schema has no satisfiable object for the presence axis to take a
    // key out of. See PRESENCE_BARREN.
    absentModes: [],
  },
  // The nullable twin of the site above, and the reason the crash-site arbitration now reads the
  // fixture column's own `notNull`. Everything about it is the same defect: official emits
  // `type: 'RegExp'` with a `maxLength` whose check reads `value.length`. What differs is the right
  // answer, and it differs because the column differs: `n_bit` is nullable, so accepting a NULL is
  // correct, and Postgres says so on a table built from this column rather than from `c_bit`'s.
  'pg/typebox/n_bit': {
    side: 'official',
    modes: ['select', 'insert', 'update'],
    values: ['null', 'undefined'],
    why: 'as pg/typebox/c_bit',
    // `reject` on `undefined` in every mode, insert and update included, because a TypeBox field
    // extracted from the parent never takes `undefined` whether or not it is optional. That is the
    // same inertness the key-presence axis exists for, seen from the value side.
    drzl: { '*/null': 'accept', '*/undefined': 'reject' },
    arbiter: {
      null: 'postgres accepts it',
      undefined: 'postgres accepts the column omitted from the insert',
    },
    // Select alone, where `c_bit` above is select and insert. A nullable column is optional on
    // insert and update, so TypeBox skips the property when the key is missing and never reaches
    // the length check that crashes.
    absentModes: ['select'],
  },
  'mysql/typebox/m_binary': {
    side: 'official',
    modes: ['select', 'insert', 'update'],
    values: ['null', 'undefined'],
    why: 'as pg/typebox/c_bit',
    drzl: { '*/null': 'reject', '*/undefined': 'reject' },
    arbiter: {
      // PGlite is a Postgres and cannot answer for a MySQL column, and there is no MySQL that runs
      // in this process. Asked out of band, a real MySQL 8.4.11 refuses a NULL into
      // `binary(4) not null` and into `varbinary(16) not null` with ERROR 1048 "Column cannot be
      // null", while the same insert carrying values stores 4 and 2 bytes. That is not this run's
      // evidence, so it is not this run's claim, and the pinned verdict is what gates here.
      //
      // The absence is unarbitrated for the same reason and not for a different one: there is a
      // way to ask it, which is to leave the column out of the insert, and no MySQL here to ask.
      // The reason is checked against the engine's own `select version()` rather than only being
      // computed by the branch that produces it.
      null: 'no in-process mysql engine',
      undefined: 'no in-process mysql engine',
    },
    absentModes: ['select', 'insert'],
  },
  'mysql/typebox/m_varbinary': {
    side: 'official',
    modes: ['select', 'insert', 'update'],
    values: ['null', 'undefined'],
    why: 'as pg/typebox/c_bit',
    drzl: { '*/null': 'reject', '*/undefined': 'reject' },
    arbiter: {
      null: 'no in-process mysql engine',
      undefined: 'no in-process mysql engine',
    },
    absentModes: ['select', 'insert'],
  },
};
// `at` is every `<side>/<mode>/<value>` that crashed, so the printed figure is a count rather than
// a cross product that happens to equal one while the pattern is a rectangle.
const threwSeen = new Map<string, { sides: Set<string>; modes: Set<string>; values: Set<string>; at: Set<string> }>();
// DRZL's own verdict on a value official crashed on, keyed by crash site then `<mode>/<value>`.
// The comparison cannot use it, which is not the same thing as nobody looking at it.
const crashVerdict = new Map<string, Map<string, string>>();
const recordCrashVerdict = (key: string, mode: string, label: string, verdict: Verdict) => {
  const seen = crashVerdict.get(key) ?? new Map<string, string>();
  seen.set(`${mode}/${label}`, verdict);
  crashVerdict.set(key, seen);
};
const recordThrow = (key: string, side: string, mode: string, value: string) => {
  const seen =
    threwSeen.get(key) ?? { sides: new Set<string>(), modes: new Set<string>(), values: new Set<string>(), at: new Set<string>() };
  seen.sides.add(side);
  seen.modes.add(mode);
  seen.values.add(value);
  seen.at.add(`${side}/${mode}/${value}`);
  threwSeen.set(key, seen);
};

/**
 * A waiver pins the exact divergence it covers, not a shape.
 *
 * `divergence` is keyed `<modes>/<libraries>`, `*` for all of them, and each value is the exact
 * signature measured for those pairings: `L: <labels DRZL accepts and official refuses> | T: <the
 * other way>`, in pool order. Three signatures are stated from the other end rather than as a
 * list: `every probe official rejects (N of them), and official accepts only: <labels>` says DRZL
 * took the whole pool, how many official refused and exactly which ones it did not, and the two
 * `has it, omits it` strings say one side produced no field at all. That first one carries both a
 * count and a complement because each without the other is a shape: with neither, official
 * narrowing its rejections to two left the signature unmoved; with the count alone, official
 * swapping which probes it refuses left it unmoved at an unchanged count. Both holes were measured
 * on the 0.4x pass, where the columns in that state live. All three are what the run produces in
 * those states, and no waiver declares any of them today, since no waived column on this major is
 * untyped or missing on one side. They are the shape a future one would take, not a claim about
 * the current list.
 *
 * Until this existed a waiver asserted only that it suppressed something, and a real regression
 * walked through it: stripping every length cap from `m_tinytext` in all four generated modules
 * left this pass green, because the column still differed, just on different values. The 0.4x
 * stage named the identical break. Two gates side by side, one absorbing regressions and one not,
 * is worse than the churn of pinning both.
 *
 * The churn is the trade and it is the right way round. A pool value that any waived column treats
 * differently from official re-opens that waiver, because the alternative is a waiver quietly
 * covering a divergence nobody has looked at.
 */
type Waiver = {
  /** The libraries this waiver covers, asserted exactly against what it suppressed. */
  libs: string[];
  /** The modes it covers, asserted the same way. */
  modes: string[];
  /** Why the divergence is deliberate. */
  why: string;
  /** The exact divergence, keyed `<modes>/<libraries>`. */
  divergence: Record<string, string>;
  /**
   * Pairings inside `libs` x `modes` that genuinely do not diverge, named one at a time.
   *
   * The product is asserted exactly, which is what stops a waiver covering four pairings while
   * claiming twelve. A real divergence that misses one cell of the product therefore has nowhere
   * to go, and the alternatives are both worse: widening `libs` or `modes` until the product fits
   * understates which pairings are waived, and splitting the column across two keys is not
   * possible since the key is the column.
   *
   * Asserted in the fail-closed direction. A pairing named here that *does* diverge fails the run,
   * so this can only ever shrink what the waiver claims, never quietly absorb a new difference.
   */
  except?: string[];
};

const LIB_NAMES = ['zod', 'valibot', 'arktype', 'typebox'];
const MODE_NAMES = ['select', 'insert', 'update'];
const WRITE = ['insert', 'update'];

// A signature for a column DRZL accepts every probe of, stated as the count of official's
// rejections plus the exact set it accepts instead. The complement is what makes it a set rather
// than a shape, and it is a handful of labels where the list it replaces is nearly the whole pool.
// See the fuller note on the same constant in the 0.4x pass below, which is where the columns in
// that state live.
//
// How many columns use it is printed by each run rather than written down here. Sentences in this
// file used to carry that number, and others carried the length of the list it replaces; adding
// five pool values made every one of them wrong in a single edit, which is the argument for
// deriving it. The sentence that stood here counted both groups and got the second group wrong,
// which is this species reproducing inside its own cure for the second time in one branch.
const allProbes = (n: number, accepted: string[]) =>
  `every probe official rejects (${n} of them), and official accepts only: ` +
  (accepted.length ? accepted.join(', ') : 'nothing in the pool');

/**
 * Does a declaration key such as `select,insert/zod` cover the pairing `select/zod`? A declaration
 * that covers no pairing, and two that cover the same one, both fail rather than being resolved by
 * precedence.
 */
const pairingMatches = (decl: string, pairing: string) => {
  const [dModes, dLibs] = decl.split('/');
  const [mode, lib] = pairing.split('/');
  const covers = (spec: string, x: string) => spec === '*' || spec.split(',').includes(x);
  return covers(dModes, mode) && covers(dLibs, lib);
};

/**
 * Divergences that are deliberate and reasoned. Anything not named here is a finding, so a new
 * disagreement fails this script rather than quietly widening the list.
 *
 * Keyed `<dialect>/<library>/<column>`; `<dialect>/<column>` applies to every library on that
 * dialect. The dialect is part of the key because this file compared all four libraries on
 * Postgres alone for most of its life, and a waiver keyed on a column name would have started
 * covering a same-named column on MySQL or SQLite the moment those dialects were widened. The
 * fixtures use distinct `c_`/`m_`/`s_` prefixes, which makes the dialect redundant today and
 * load-bearing the day someone adds a column without one.
 */
const ALLOWED: Record<string, Waiver> = {
  // Binary payloads are typed as Uint8Array rather than Buffer. A Buffer is a Uint8Array, so
  // nothing official accepts is turned away. The wider check needs no `@types/node`, survives a
  // runtime where `Buffer` is undefined, and makes bytea and blob validate the same way.
  'pg/c_bytea': { libs: LIB_NAMES, modes: MODE_NAMES, why: 'Uint8Array accepted where official demands a Buffer', divergence: { '*/*': `L: Uint8Array | T: ` } },
  'sqlite/s_blob_buf': { libs: LIB_NAMES, modes: MODE_NAMES, why: 'as pg/c_bytea', divergence: { '*/*': `L: Uint8Array | T: ` } },
  // `coerceDates` defaults to coercing on insert and update, which is a documented DRZL option
  // and is what `coerceDates: 'none'` turns off to match official exactly. Only strings and
  // numbers are coerced: null, booleans and arrays are rejected, which `z.coerce.date()` accepts.
  //
  // One arm, where there were two. The split existed because zod alone had a number branch, so
  // only zod diverged from official on an epoch number; BC gave the other three one and the four
  // signatures became identical. The same waiver also used to carry `'hello'`, `'zzz'` and 22000
  // CJK characters under a `why` that said "a date string or epoch number", describing neither
  // of them, which is what BA fixed.
  'pg/c_date_d': {
    libs: LIB_NAMES,
    modes: WRITE,
    why: 'coerceDates accepts a parseable date string or an epoch number on write, in all four generators',
    divergence: {
      '*/*': `L: 0, 1, 1.5, -1, 200, 40000, 9000000, 2147483648, 1900, 2000, 2500, '2020-01-01', '2020-01-01T00:00:00Z', 17, 18, 50, 100, 101, 4294967295, 4294967296 | T: `,
    },
  },
  'pg/c_ts_d': {
    libs: LIB_NAMES,
    modes: WRITE,
    why: 'as pg/c_date_d',
    divergence: {
      '*/*': `L: 0, 1, 1.5, -1, 200, 40000, 9000000, 2147483648, 1900, 2000, 2500, '2020-01-01', '2020-01-01T00:00:00Z', 17, 18, 50, 100, 101, 4294967295, 4294967296 | T: `,
    },
  },
  'mysql/m_date': {
    libs: LIB_NAMES,
    modes: WRITE,
    why: 'as pg/c_date_d',
    divergence: {
      '*/*': `L: 0, 1, 1.5, -1, 200, 40000, 9000000, 2147483648, 1900, 2000, 2500, '2020-01-01', '2020-01-01T00:00:00Z', 17, 18, 50, 100, 101, 4294967295, 4294967296 | T: `,
    },
  },
  'mysql/m_datetime': {
    libs: LIB_NAMES,
    modes: WRITE,
    why: 'as pg/c_date_d',
    divergence: {
      '*/*': `L: 0, 1, 1.5, -1, 200, 40000, 9000000, 2147483648, 1900, 2000, 2500, '2020-01-01', '2020-01-01T00:00:00Z', 17, 18, 50, 100, 101, 4294967295, 4294967296 | T: `,
    },
  },
  'mysql/m_ts': {
    libs: LIB_NAMES,
    modes: WRITE,
    why: 'as pg/c_date_d',
    divergence: {
      '*/*': `L: 0, 1, 1.5, -1, 200, 40000, 9000000, 2147483648, 1900, 2000, 2500, '2020-01-01', '2020-01-01T00:00:00Z', 17, 18, 50, 100, 101, 4294967295, 4294967296 | T: `,
    },
  },
  'sqlite/s_int_ts': {
    libs: LIB_NAMES,
    modes: WRITE,
    why: 'as pg/c_date_d',
    divergence: {
      '*/*': `L: 0, 1, 1.5, -1, 200, 40000, 9000000, 2147483648, 1900, 2000, 2500, '2020-01-01', '2020-01-01T00:00:00Z', 17, 18, 50, 100, 101, 4294967295, 4294967296 | T: `,
    },
  },
  'sqlite/s_int_ts_ms': {
    libs: LIB_NAMES,
    modes: WRITE,
    why: 'as pg/c_date_d',
    divergence: {
      '*/*': `L: 0, 1, 1.5, -1, 200, 40000, 9000000, 2147483648, 1900, 2000, 2500, '2020-01-01', '2020-01-01T00:00:00Z', 17, 18, 50, 100, 101, 4294967295, 4294967296 | T: `,
    },
  },
  // Official emits `Type.String({ format: 'uuid' })`, and TypeBox fails a format it has no entry
  // for rather than ignoring it, so that schema rejects every valid uuid in any project that has
  // not populated `FormatRegistry` first. This generator emits a pattern, which needs no setup.
  'pg/typebox/c_uuid': { libs: ['typebox'], modes: MODE_NAMES, why: 'official uses an unregistered `format`, which rejects every uuid', divergence: { '*/*': `L: uuid | T: ` } },
  // A character limit counts *characters*; official counts `.length`, which is UTF-16 units, so
  // it refuses three emoji in a `char(4)` the database accepts. Measured against Postgres: three
  // emoji insert into a `char(4)` and read back as four code points, which are seven UTF-16 units.
  'pg/c_char': { libs: LIB_NAMES, modes: MODE_NAMES, why: 'character limit counts code points; official counts UTF-16 units', divergence: { '*/*': `L: 3 emoji | T: ` } },
  'mysql/m_char': { libs: LIB_NAMES, modes: MODE_NAMES, why: 'as pg/c_char', divergence: { '*/*': `L: 3 emoji | T: ` } },
  // MySQL's TEXT family is capped in bytes and official caps it in UTF-16 units, so official takes
  // a 100 emoji string that is 200 units and 400 bytes into a `tinytext` whose budget is 255. DRZL
  // emits the byte check and refuses it. A real MySQL 8 on a utf8mb4 client is the authority and
  // agrees with DRZL: that insert fails with "Data too long", while the same string goes into a
  // `varchar(255)` and reports `length` 400 with `char_length` 100.
  //
  // Which columns the pool reaches is arithmetic, not luck. A separating probe is over the cap in
  // bytes and not over it in UTF-16 units, and UTF-8 spends at most 3 bytes per unit, so it needs
  // more than cap/3 units. That is 86 for `tinytext` and 21846 for `text` and `blob`, all three in
  // the pool, against 5592406 for `mediumtext` and 1431655766 for `longtext`, which are not.
  //
  // Which of them anything measures is not stated here at all any more, because both previous
  // attempts at that sentence were false and the second was written by the fix for the first. It is
  // computed per column and asserted in CAP_COVERAGE further down this file, so a claim about
  // coverage fails when it stops being true instead of being re-read as true.
  'mysql/m_tinytext': { libs: LIB_NAMES, modes: MODE_NAMES, why: 'MySQL caps TEXT in bytes; official caps it in UTF-16 units, and takes 400 bytes into a 255 byte column', divergence: { '*/*': `L:  | T: 100 emoji` } },
  'mysql/m_text': { libs: LIB_NAMES, modes: MODE_NAMES, why: 'as mysql/m_tinytext, 66000 bytes against a 65535 byte budget', divergence: { '*/*': `L:  | T: 22000 cjk` } },
  // The blob half of the same table, which only this pass reaches: 0.4x's mysql-core has no `blob`
  // export at all, so the 0.4x fixture drops the column. MySQL 8.4 answers the same way for it as
  // for `text`: both refuse the 22000 CJK string with "Data too long", and `mediumtext` in the same
  // table takes it and stores 66000 bytes, which is what shows the probe is measuring the cap.
  'mysql/m_blob': { libs: LIB_NAMES, modes: MODE_NAMES, why: 'as mysql/m_tinytext, on a BLOB whose budget is also 65535 bytes', divergence: { '*/*': `L:  | T: 22000 cjk` } },
  // Stricter than official, and verified against Postgres itself through PGlite: a `numeric`
  // column is a string, and a bare string schema accepts 'hello' where the database rejects it.
  // Official accepts all of these; the database does not.
  'pg/c_numeric': { libs: LIB_NAMES, modes: MODE_NAMES, why: 'numeric format enforced; official accepts any string, Postgres does not', divergence: { '*/*': `L:  | T: "", 'hello', 300-char, 70k-char, 5-char, 3 emoji, 5 emoji, 'not-a-uuid', uuid, 'zzz', 'a', 'happy', 'x', '2020-01-01', '2020-01-01T00:00:00Z', '12:00:00', '25:99:99', 100 emoji, 22000 cjk, '999.999.999.999', '10.0.0.1'` } },
  'pg/c_decimal': { libs: LIB_NAMES, modes: MODE_NAMES, why: 'as pg/c_numeric', divergence: { '*/*': `L:  | T: "", 'hello', 300-char, 70k-char, 5-char, 3 emoji, 5 emoji, 'not-a-uuid', uuid, 'zzz', 'a', 'happy', 'x', '2020-01-01', '2020-01-01T00:00:00Z', '12:00:00', '25:99:99', 100 emoji, 22000 cjk, '999.999.999.999', '10.0.0.1'` } },
  'mysql/m_decimal': { libs: LIB_NAMES, modes: MODE_NAMES, why: 'as pg/c_numeric', divergence: { '*/*': `L:  | T: "", 'hello', 300-char, 70k-char, 5-char, 3 emoji, 5 emoji, 'not-a-uuid', uuid, 'zzz', 'a', 'happy', 'x', '2020-01-01', '2020-01-01T00:00:00Z', '12:00:00', '25:99:99', 100 emoji, 22000 cjk, '999.999.999.999', '10.0.0.1'` } },
  // Stricter than official, in DRZL's favour.
  'pg/valibot/c_json': { libs: ['valibot'], modes: MODE_NAMES, why: 'DRZL rejects Infinity and non-plain objects; official accepts both', divergence: { '*/*': `L:  | T: Infinity, Date, Buffer, Uint8Array` } },
  'pg/valibot/c_jsonb': { libs: ['valibot'], modes: MODE_NAMES, why: 'as pg/valibot/c_json', divergence: { '*/*': `L:  | T: Infinity, Date, Buffer, Uint8Array` } },
  'pg/valibot/c_jsonb_typed': { libs: ['valibot'], modes: MODE_NAMES, why: 'as pg/valibot/c_json', divergence: { '*/*': `L:  | T: Infinity, Date, Buffer, Uint8Array` } },
  'mysql/valibot/m_json': { libs: ['valibot'], modes: MODE_NAMES, why: 'as pg/valibot/c_json', divergence: { '*/*': `L:  | T: Infinity, Date, Buffer, Uint8Array` } },
  'sqlite/valibot/s_text_json': { libs: ['valibot'], modes: MODE_NAMES, why: 'as pg/valibot/c_json', divergence: { '*/*': `L:  | T: Infinity, Date, Buffer, Uint8Array` } },
  'sqlite/valibot/s_blob_json': { libs: ['valibot'], modes: MODE_NAMES, why: 'as pg/valibot/c_json', divergence: { '*/*': `L:  | T: Infinity, Date, Buffer, Uint8Array` } },
  // A `blob()` with no mode is Drizzle's json mode, not its buffer mode, so this is the same
  // column shape as s_blob_json and gets the same reasoning. `s_blob_buf` above is the buffer one.
  'sqlite/valibot/s_blob': { libs: ['valibot'], modes: MODE_NAMES, why: 'as pg/valibot/c_json; a bare blob() is Drizzle json mode', divergence: { '*/*': `L:  | T: Infinity, Date, Buffer, Uint8Array` } },
  'pg/valibot/c_point': { libs: ['valibot'], modes: MODE_NAMES, why: 'v.strictTuple rejects a third element; official v.tuple ignores extras', divergence: { '*/*': `L:  | T: [1,2,3]` } },
  'pg/valibot/c_geometry': { libs: ['valibot'], modes: MODE_NAMES, why: 'as pg/valibot/c_point', divergence: { '*/*': `L:  | T: [1,2,3]` } },
  // Looser than official on purpose. An earlier version of this sentence called these the only
  // entries in either pass that run that way, and the map around it refutes that: the run prints
  // how many waivers have DRZL accepting something official refuses, and it is most of them.
  // `pg/c_char` takes three emoji into a `char(3)`, `pg/c_bytea` takes a Uint8Array, and
  // `pg/typebox/c_uuid` takes a uuid TypeBox refuses until a FormatRegistry is populated. Postgres
  // accepts all three. The uuid one is keyed by library because only TypeBox has it.
  //
  // What is unusual about these six is narrower and worth reading for: they are looser on a
  // *numeric range*, which is the kind of divergence this gate was built to catch, and they got
  // that way by moving off the first-party module's numbers rather than by never having had any.
  // The database is the arbiter here, not the first-party module, and it was asked directly
  // through PGlite on each column's own SQL type.
  //
  // `real` / float4. Official bounds it at +/-8388607, and the column stores 8388608, 9000000,
  // 1e9 and 2147483648 and returns every one of them unchanged, and holds every integer exactly
  // to 16777216. So official's bound refuses rows the column hands back, and a select schema that
  // did the same refused its own rows. DRZL bounds it where the database does instead, bisected
  // over the raw bit pattern of a double: 3.4028235677973366e38 is accepted and the next double
  // up answers `... is out of range for type real`. That is why 9007199254740993 and
  // 3.4028235e38 are in the signature and 1e300 is not.
  //
  // `pg/c_real` and `mysql/m_float` are the same width and do not have the same bound, which is
  // why they no longer share a signature. Postgres takes 268435456 representable doubles past the
  // largest float32 and stores the float32 for each; MySQL 8.4 refuses the very next double,
  // measured in `STRICT_ALL_TABLES` and again under the stock MySQL 8 `sql_mode`. The probe that
  // separates them is `3.4028235e38`, which is what a full-magnitude float4 looks like coming
  // back over the text protocol.
  //
  // `double precision` / float8 and everything else backed by an 8 byte float. No bound at all,
  // because there is no finite one that is true: float8 is the JavaScript number's own format and
  // Postgres accepted every finite JS number into one, measured to Number.MAX_VALUE and returned
  // identical. Official bounds it at +/-140737488355327, which refuses 1.75e15, an ordinary
  // microsecond epoch.
  //
  // DRZL was on official's numbers for one release and this is the correction. The failure text
  // this gate prints for an unwaived difference used to gloss "looser than the first-party module"
  // as "accepts rows the database will reject", which is exactly the equivalence that does not hold
  // for these six: the database accepts every value in these signatures except the ones noted
  // below. That sentence has been rewritten rather than caveated, because it was already false of
  // five waived columns before these six arrived.
  //
  // Two values in these signatures the database is not on DRZL's side about:
  //   9007199254740993   the JS literal is 9007199254740992, which a float8 holds exactly and a
  //                      float4 rounds. Postgres stores it in both. It is here because no bound
  //                      excludes it, not because a bound was chosen to admit it.
  //   Infinity           Postgres stores and returns it in both types, so accepting it is right;
  //                      only valibot and arktype do, because `z.number()` and `Type.Number()`
  //                      refuse it with no bound at all. Filed: describing that column honestly
  //                      needs a union in every generator rather than a range.
  // The arktype update arm gains `Infinity` alone rather than `NaN, Infinity`. Not a gap in the
  // fix: official `drizzle-orm/arktype` already accepts NaN in its union-shaped arms, so NaN was
  // never a divergence there and still is not. Measured directly: `{x:'number'}` rejects NaN,
  // `{x:'(bound | null)'}` accepts it.
  'pg/c_real': { libs: LIB_NAMES, modes: MODE_NAMES, why: 'bounded where Postgres stops accepting rather than at drizzle-zod +/-8388607, which refuses rows the column returns. Non-finite values were added on top: Postgres stores NaN and both infinities in a float column and returns them, and a Select schema refusing what the database hands back fails on real rows (AW).', divergence: { 'select,insert/*': `L: 9000000, 2147483648, 9007199254740993, 3.4028235e38, NaN, Infinity, 4294967295, 4294967296 | T: `, 'update/zod,valibot,typebox': `L: 9000000, 2147483648, 9007199254740993, 3.4028235e38, NaN, Infinity, 4294967295, 4294967296 | T: `, 'update/arktype': `L: 9000000, 2147483648, 9007199254740993, 3.4028235e38, Infinity, 4294967295, 4294967296 | T: ` } },
  'mysql/m_float': { libs: LIB_NAMES, modes: MODE_NAMES, why: 'as pg/c_real, but at MySQL edge: a real MySQL 8.4 refuses 3.4028235e38 where Postgres takes it', divergence: { '*/zod,valibot,typebox': `L: 9000000, 2147483648, 9007199254740993, 4294967295, 4294967296 | T: `, 'update/arktype': `L: 9000000, 2147483648, 9007199254740993, 4294967295, 4294967296 | T: NaN`, 'select,insert/arktype': `L: 9000000, 2147483648, 9007199254740993, 4294967295, 4294967296 | T: ` } },
  // All four libraries now carry the same signature, where zod and typebox used to differ from
  // valibot and arktype on the infinities. That convergence is the fix: the two that refused a
  // non-finite number no longer do.
  // Two facts, and the second one is new. Postgres takes NaN into a numeric whether or not it
  // carries a precision, so DRZL is looser there and right to be. It now also **refuses** what the
  // column refuses: `numeric(10,2)` answers `22003 numeric field overflow` for 2147483648, and
  // official accepts it because neither drizzle major nor `drizzle-zod` reads precision or scale.
  // Being out of step with them is the correct outcome when the database is the arbiter (AK).
  //
  // The infinity half of the old note is gone, and so is its reason. It read "the analyzer does not
  // read precision or scale at all, so it cannot tell the two declarations apart". It reads both
  // now, so the split it could not make is the split it makes: an unconstrained `numeric` takes
  // both infinities and one carrying a precision answers 22003, which is exactly `allowsInfinity =
  // !declaredPrecision`. A recorded reason that stops being true is a reason to revisit the
  // decision it justified, not a sentence to leave standing.
  //
  // No `except` any more. It named update/arktype as the one cell of twelve reporting parity, and
  // that cell diverges now: official accepts the value the column refuses there too.
  'pg/c_numeric_n': { libs: LIB_NAMES, modes: MODE_NAMES, why: 'Postgres stores NaN in a numeric column and returns it, and refuses a value past the declared precision; official reads no precision so it accepts what the column will not hold', divergence: { 'select,insert/*': `L: NaN | T: 2147483648, 4294967295, 4294967296`, 'update/zod,valibot,typebox': `L: NaN | T: 2147483648, 4294967295, 4294967296`, 'update/arktype': `L:  | T: 2147483648, 4294967295, 4294967296` } },
  'pg/c_double': { libs: LIB_NAMES, modes: MODE_NAMES, why: 'no finite bound is true of an 8 byte float, which holds every finite JS number. Non-finite values were added on top: Postgres stores NaN and both infinities in a float column and returns them, and a Select schema refusing what the database hands back fails on real rows (AW).', divergence: { 'select,insert/*': `L: 9007199254740993, 3.4028235e38, NaN, Infinity | T: `, 'update/zod,valibot,typebox': `L: 9007199254740993, 3.4028235e38, NaN, Infinity | T: `, 'update/arktype': `L: 9007199254740993, 3.4028235e38, Infinity | T: ` } },
  // Only the magnitudes now. The `Infinity` term these two carried was the entry reading "as
  // pg/c_double" on a column whose database is not Postgres: an 8 byte float stores an infinity
  // there and MySQL 8.4.11 answers ER_WARN_DATA_OUT_OF_RANGE for `Infinity`, `-Infinity` and `NaN`
  // alike on `float`, `double` and `real`, measured on the binary prepared path, which is the one
  // that puts the real IEEE double on the wire. The analyzer states that refusal now, valibot and
  // arktype refuse it with it, and all four generators agree with official on those two values
  // (BU). What is left is the pair of magnitudes, where DRZL is looser because no finite bound is
  // truthful of an 8 byte float, and arktype's update-only NaN narrow.
  'mysql/m_real': { libs: LIB_NAMES, modes: MODE_NAMES, why: 'as pg/c_double at the magnitudes; MySQL REAL is a synonym for DOUBLE. Not as pg/c_double on the infinities, which is where the two databases part and this entry used to claim they did not', divergence: { '*/zod,valibot,typebox': `L: 9007199254740993, 3.4028235e38 | T: `, 'update/arktype': `L: 9007199254740993, 3.4028235e38 | T: NaN`, 'select,insert/arktype': `L: 9007199254740993, 3.4028235e38 | T: ` } },
  'mysql/m_double': { libs: LIB_NAMES, modes: MODE_NAMES, why: 'as mysql/m_real, which is the same column under its other name', divergence: { '*/zod,valibot,typebox': `L: 9007199254740993, 3.4028235e38 | T: `, 'update/arktype': `L: 9007199254740993, 3.4028235e38 | T: NaN`, 'select,insert/arktype': `L: 9007199254740993, 3.4028235e38 | T: ` } },
  'sqlite/s_real': { libs: LIB_NAMES, modes: MODE_NAMES, why: 'as pg/c_double; SQLite REAL is an 8 byte IEEE float', divergence: { '*/zod,typebox': `L: 9007199254740993, 3.4028235e38 | T: `, '*/valibot': `L: 9007199254740993, 3.4028235e38, Infinity | T: `, 'update/arktype': `L: 9007199254740993, 3.4028235e38, Infinity | T: NaN`, 'select,insert/arktype': `L: 9007199254740993, 3.4028235e38, Infinity | T: ` } },
  // ---- binary and varbinary, where official refuses rows the server returns --------------------
  // Official emits `^[01]*$` capped at n for these columns on v1, which is a bit-string pattern on
  // a column holding arbitrary bytes, so it rejects every ordinary string MySQL hands back. Asked
  // of a live MySQL 8.4 through both majors: mysql2 hands up a Buffer and drizzle hands the
  // CONSUMER a string, value for value identical, with `instanceof Uint8Array` false on all four
  // builders. So DRZL emitting a plain string is the database's answer and official's pattern is
  // the divergence.
  //
  // `T:` stays empty and `L:` carries the load. DRZL is looser here and right, which is the
  // direction this ledger exists to record rather than forbid.
  //
  // Insert and update drop one value each against select, and that is the declared width doing its
  // job rather than noise: '3 emoji' is 12 bytes over a `binary(4)` and '5 emoji' is 20 over a
  // `varbinary(16)`, so DRZL refuses them on the way in and both sides agree.
  //
  // These were two typebox-only entries, because the `L:` half did not exist while DRZL emitted a
  // Uint8Array and refused everything. Widening them to every library is what this change forces.
  //
  // The typebox-only reason SURVIVES, on the `T:` half, and a first draft of this comment claimed
  // it had gone. The stage refuted that in one run: `L:` matched on all twelve pairings and typebox
  // still measured `T: []`. Official emits `Type.RegExp`, whose check runs `RegExp.prototype.test`
  // on the raw value, and `test` stringifies what it is given, so `[]` becomes '' and matches
  // `^[01]*$`. DRZL emits a `string` carrying a `pattern` and refuses a non-string before the
  // pattern is consulted. So typebox carries both halves and the other three carry only `L:`.
  'mysql/m_binary': {
    libs: LIB_NAMES,
    modes: MODE_NAMES,
    why: 'official emits a bit-string pattern for a byte column and refuses the strings MySQL returns',
    divergence: {
      'select/typebox': `L: 3 emoji, 'zzz', 'a', 'x', '12.5' | T: []`,
      'select/zod,valibot,arktype': `L: 3 emoji, 'zzz', 'a', 'x', '12.5' | T: `,
      'insert,update/typebox': `L: 'zzz', 'a', 'x', '12.5' | T: []`,
      'insert,update/zod,valibot,arktype': `L: 'zzz', 'a', 'x', '12.5' | T: `,
    },
  },
  'mysql/m_varbinary': {
    libs: LIB_NAMES,
    modes: MODE_NAMES,
    why: 'as mysql/m_binary',
    divergence: {
      'select/typebox': `L: 'hello', 5-char, 3 emoji, 5 emoji, 'not-a-uuid', 'zzz', 'a', 'happy', 'x', '2020-01-01', '12:00:00', '25:99:99', '999.999.999.999', '10.0.0.1', '12.5' | T: []`,
      'select/zod,valibot,arktype': `L: 'hello', 5-char, 3 emoji, 5 emoji, 'not-a-uuid', 'zzz', 'a', 'happy', 'x', '2020-01-01', '12:00:00', '25:99:99', '999.999.999.999', '10.0.0.1', '12.5' | T: `,
      'insert,update/typebox': `L: 'hello', 5-char, 3 emoji, 'not-a-uuid', 'zzz', 'a', 'happy', 'x', '2020-01-01', '12:00:00', '25:99:99', '999.999.999.999', '10.0.0.1', '12.5' | T: []`,
      'insert,update/zod,valibot,arktype': `L: 'hello', 5-char, 3 emoji, 'not-a-uuid', 'zzz', 'a', 'happy', 'x', '2020-01-01', '12:00:00', '25:99:99', '999.999.999.999', '10.0.0.1', '12.5' | T: `,
    },
  },
  // ---- the nullable table ---------------------------------------------------------------------
  // Every divergence below is the one its `notNull` twin in `matrix` already carries, measured
  // again through the wrapper each generator puts round a nullable column. That is the point: the
  // wrapping is where a constraint gets lost, and a signature identical to the twin's is the
  // evidence that nothing was lost. Three have no twin and they are the three CHECK columns,
  // because no column of `matrix` carries a CHECK.
  // Every arktype arm gains `Infinity` alone here, where `c_real` above diverges only on update:
  // the nullable wrapper makes all three modes union shaped, and official accepts NaN in all of
  // them. Same reason, wider reach.
  'pg/n_real': { libs: LIB_NAMES, modes: MODE_NAMES, why: 'as pg/c_real, through the nullable wrapper', divergence: { '*/zod,valibot,typebox': `L: 9000000, 2147483648, 9007199254740993, 3.4028235e38, NaN, Infinity, 4294967295, 4294967296 | T: `, '*/arktype': `L: 9000000, 2147483648, 9007199254740993, 3.4028235e38, Infinity, 4294967295, 4294967296 | T: ` } },
  'pg/c_bytea_null': { libs: LIB_NAMES, modes: MODE_NAMES, why: 'as pg/c_bytea, through the nullable wrapper', divergence: { '*/*': `L: Uint8Array | T: ` } },
  'pg/valibot/n_json': { libs: ['valibot'], modes: MODE_NAMES, why: 'as pg/valibot/c_json', divergence: { '*/*': `L:  | T: Infinity, Date, Buffer, Uint8Array` } },
  'pg/valibot/n_point': { libs: ['valibot'], modes: MODE_NAMES, why: 'as pg/valibot/c_point', divergence: { '*/*': `L:  | T: [1,2,3]` } },
  'pg/valibot/n_geometry': { libs: ['valibot'], modes: MODE_NAMES, why: 'as pg/valibot/c_geometry', divergence: { '*/*': `L:  | T: [1,2,3]` } },
  'pg/n_ts': {
    libs: LIB_NAMES,
    modes: WRITE,
    why: 'as pg/c_ts_d',
    divergence: {
      '*/*': `L: 0, 1, 1.5, -1, 200, 40000, 9000000, 2147483648, 1900, 2000, 2500, '2020-01-01', '2020-01-01T00:00:00Z', 17, 18, 50, 100, 101, 4294967295, 4294967296 | T: `,
    },
  },
  // The first divergence in either pass that comes from a CHECK, because `matrix` carries none and
  // the `checked` table is not in this comparison. DRZL reads the constraint and emits it; no
  // first-party module reads one at all, so official accepts values the column cannot hold.
  //
  // The database is the arbiter and it has already answered, in this same script: the CHECK
  // ground-truth stage runs 59 probes against a real Postgres over the `checked` table and reports
  // rows Postgres rejects and the validator accepts as DRZL 0, drizzle-orm 24.
  //
  // `BETWEEN 18 AND 100` rather than a one-sided bound, and the reason is the ledger rather than
  // the coverage: on SQLite a one-sided `>= 18` leaves the column's own upper bound in place, and
  // that upper bound is a filed defect on 0.4x, so the column carried a deliberate difference and a
  // defect at once and could not go in one map honestly. A two-sided CHECK replaces both bounds and
  // leaves this entry about the CHECK alone.
  'pg/n_check': { libs: LIB_NAMES, modes: MODE_NAMES, why: 'DRZL enforces the column CHECK; no first-party module reads one', divergence: { '*/*': `L:  | T: 0, 1, -1, 200, 40000, 9000000, 1900, 2000, 2500, 17, 101` } },
  'mysql/m_n_text': { libs: LIB_NAMES, modes: MODE_NAMES, why: 'as mysql/m_text', divergence: { '*/*': `L:  | T: 22000 cjk` } },
  'mysql/m_n_tinytext': { libs: LIB_NAMES, modes: MODE_NAMES, why: 'as mysql/m_tinytext', divergence: { '*/*': `L:  | T: 100 emoji` } },
  'mysql/m_n_float': { libs: LIB_NAMES, modes: MODE_NAMES, why: 'as mysql/m_float, and arktype is tighter in every mode rather than only on update: the nullable arm leaks on the object, the optional one only through the key', divergence: { '*/zod,valibot,typebox': `L: 9000000, 2147483648, 9007199254740993, 4294967295, 4294967296 | T: `, '*/arktype': `L: 9000000, 2147483648, 9007199254740993, 4294967295, 4294967296 | T: NaN` } },
  'mysql/valibot/m_n_json': { libs: ['valibot'], modes: MODE_NAMES, why: 'as pg/valibot/c_json', divergence: { '*/*': `L:  | T: Infinity, Date, Buffer, Uint8Array` } },
  'mysql/m_n_datetime': {
    libs: LIB_NAMES,
    modes: WRITE,
    why: 'as pg/c_date_d',
    divergence: {
      '*/*': `L: 0, 1, 1.5, -1, 200, 40000, 9000000, 2147483648, 1900, 2000, 2500, '2020-01-01', '2020-01-01T00:00:00Z', 17, 18, 50, 100, 101, 4294967295, 4294967296 | T: `,
    },
  },
  'mysql/m_n_check': { libs: LIB_NAMES, modes: MODE_NAMES, why: 'as pg/n_check, in MySQL spelling', divergence: { '*/*': `L:  | T: 0, 1, -1, 200, 40000, 9000000, 1900, 2000, 2500, 17, 101` } },
  'sqlite/s_n_real': { libs: LIB_NAMES, modes: MODE_NAMES, why: 'as sqlite/s_real', divergence: { '*/zod,typebox': `L: 9007199254740993, 3.4028235e38 | T: `, '*/valibot': `L: 9007199254740993, 3.4028235e38, Infinity | T: `, '*/arktype': `L: 9007199254740993, 3.4028235e38, Infinity | T: NaN` } },
  'sqlite/s_n_blob': { libs: LIB_NAMES, modes: MODE_NAMES, why: 'as sqlite/s_blob_buf', divergence: { '*/*': `L: Uint8Array | T: ` } },
  'sqlite/valibot/s_n_json': { libs: ['valibot'], modes: MODE_NAMES, why: 'as pg/valibot/c_json', divergence: { '*/*': `L:  | T: Infinity, Date, Buffer, Uint8Array` } },
  'sqlite/s_n_ts': {
    libs: LIB_NAMES,
    modes: WRITE,
    why: 'as sqlite/s_int_ts',
    divergence: {
      '*/*': `L: 0, 1, 1.5, -1, 200, 40000, 9000000, 2147483648, 1900, 2000, 2500, '2020-01-01', '2020-01-01T00:00:00Z', 17, 18, 50, 100, 101, 4294967295, 4294967296 | T: `,
    },
  },
  'sqlite/s_n_ts_ms': {
    libs: LIB_NAMES,
    modes: WRITE,
    why: 'as sqlite/s_int_ts_ms',
    divergence: {
      '*/*': `L: 0, 1, 1.5, -1, 200, 40000, 9000000, 2147483648, 1900, 2000, 2500, '2020-01-01', '2020-01-01T00:00:00Z', 17, 18, 50, 100, 101, 4294967295, 4294967296 | T: `,
    },
  },
  'sqlite/s_n_check': { libs: LIB_NAMES, modes: MODE_NAMES, why: "as pg/n_check; the extra label is official's SQLite integer bound being the safe-integer range where its Postgres one is int32", divergence: { '*/*': `L:  | T: 0, 1, -1, 200, 40000, 9000000, 2147483648, 1900, 2000, 2500, 17, 101, 4294967295, 4294967296` } },

  // No arktype bigint entry. There were three, reading "ArkType cannot bound a bigint in its
  // string DSL", and only half of that was true: the DSL cannot state the bound, but a narrow can,
  // and this generator already used narrows for every character cap. The generator now bounds
  // bigint columns and all four agree.
  //
  // That trio used to be described here as the one place in this whole gate where DRZL was looser
  // than the first-party module. It never was: the run counts the waivers where DRZL accepts
  // something official refuses and prints the number, and it is most of them. What made those
  // three worth fixing rather than waiving is that no int64 column can hold the value they let
  // through.
};

const usedWaivers = new Set<string>();
// What each waiver actually suppressed, keyed waiver then `<mode>/<library>`, so the declaration
// above can be compared with the run rather than merely counted.
const waived = new Map<string, Map<string, string>>();
const allowed = (dialect: string, lib: string, col: string, mode: string, signature: string) => {
  for (const key of [`${dialect}/${lib}/${col}`, `${dialect}/${col}`]) {
    if (!ALLOWED[key]) continue;
    usedWaivers.add(key);
    const seen = waived.get(key) ?? new Map<string, string>();
    seen.set(`${mode}/${lib}`, signature);
    waived.set(key, seen);
    return ALLOWED[key].why;
  }
  return undefined;
};

/**
 * Presence differences that are deliberate: DRZL and official disagree about whether a key may be
 * missing, and DRZL is right to.
 *
 * A separate map from ALLOWED because it answers a separate question and its signature has a
 * separate shape: `official <optional|required>, DRZL <the same two>`, one per pairing. Keyed and
 * asserted exactly like ALLOWED, in both directions, so an entry that suppresses nothing fails and
 * an entry whose pairings have moved fails with the measured reading printed.
 */
const PRESENCE_ALLOWED: Record<string, Waiver> = {
  // DRZL is the stricter side here, and that is the whole point of the change that produced it.
  // A nullable `customType` cannot be named by any analyzer, so its schema is an unknown. TypeBox
  // used to wrap that in `Type.Union([Type.Unknown(), Type.Null()])`, and a union's own kind is
  // `Union`, so the guard that refuses an absent key for an `Unknown` property never fired: a row
  // that never mentioned the column validated clean against a schema declaring it, while the
  // serialised JSON Schema said `"required": ["s_n_custom"]` either way.
  //
  // Official emits the identical union, so both sides agreed and no differential check could see
  // it. It took an absolute assertion, that a select schema requires every key, to find at all.
  // Now that DRZL emits a bare unknown, which already admits null and keeps its key, this pairing
  // is the one place the fix is visible as a divergence (AQ).
  'sqlite/typebox/s_n_custom': {
    libs: ['typebox'],
    modes: ['select'],
    why: 'a nullable unknown keeps its key in DRZL; official wraps it in a union whose key TypeBox lets go missing',
    divergence: { 'select/typebox': `official optional, DRZL required` },
  },
};

/**
 * Where the presence axis cannot read a side at all, because that side's schema for the column
 * accepts nothing in the pool and so no object satisfying it exists.
 *
 * One entry, and it is the same fact `ALLOWED[pg/typebox/c_uuid]` already records from the other
 * end: official emits `Type.String({ format: 'uuid' })`, TypeBox fails a format it has no entry
 * for, and no `FormatRegistry` is populated here. So that field refuses every value including a
 * valid uuid, which is what makes DRZL's pattern the usable one and what makes this pairing
 * unreadable. On select and insert the column is required, so the whole object goes with it; on
 * update it is optional and only that one column is lost.
 *
 * Keyed `<dialect>/<library>/<column>` and asserted in both directions: an undeclared barren column
 * fails, and a declaration that stops being barren fails too.
 */
const PRESENCE_BARREN: Record<string, string> = {
  'pg/typebox/c_uuid': "official's Type.String({ format: 'uuid' }) refuses every value with no FormatRegistry",
};
const usedBarren = new Set<string>();
let presenceUnreadable = 0;

/**
 * The absolute half of the presence axis: on `select`, DRZL's own schema has to require every key.
 *
 * The comparison above is differential and can only see DRZL and official disagreeing. It cannot
 * see them agreeing about something wrong, and on this major that is the only state this defect
 * comes in: for a nullable column the analyzer cannot name, both sides emit
 * `Type.Union([Type.Unknown(), Type.Null()])`, whose key TypeBox lets go missing, so a row that
 * never mentioned the column validates against both. Measured on `drizzle-orm/typebox-legacy`
 * 1.0.0-rc.4 and on DRZL's output for the same column, side by side:
 *
 *   official `s_n_custom`  {"anyOf":[{},{"type":"null"}]}   the key omitted   accepted
 *   DRZL     `s_n_custom`  {"anyOf":[{},{"type":"null"}]}   the key omitted   accepted
 *   either one with `s_n_ts_ms` omitted instead                               refused
 *
 * A select row always carries every column, so an optional key there is wrong however many
 * libraries agree about it. Keyed `<dialect>/<library>/<column>`, asserted in both directions: an
 * undeclared optional select key fails, and a declaration whose key is required now fails too.
 *
 * Only TypeBox reaches it. zod, valibot and arktype all keep the key required for their own
 * nullable unknown, which this run measures rather than assumes, since an entry naming one of them
 * would go dead.
 */
const SELECT_OPTIONAL: Record<string, string> = {
};
const usedSelectOptional = new Set<string>();
const selectOptionalProblems: string[] = [];

/**
 * How far the check above actually reached, declared and asserted in both directions.
 *
 * An absolute check has no second side to disagree with it, so a shrinking reach is invisible in
 * its own output: it inspects fewer schemas, finds nothing, and prints the same line. Measured
 * rather than feared. Making DRZL's Postgres TypeBox `SelectmatrixSchema` barren at `c_uuid`, the
 * column `PRESENCE_BARREN` already declares on official's side, drops all 40 of that pairing's keys
 * out of the absolute check, and it hid a `c_text` key made optional in the same edit. Every
 * presence counter and the `N column(s) whose key ...` line were byte identical to a clean run.
 *
 * So the reach is a declaration like any other. `SCHEMAS` is every `<dialect>/<table>/<library>`
 * whose select schema yielded at least one key to inspect, and `KEYS` is how many keys that was.
 * Both are measured by the run and compared with these, so examining fewer fails and examining more
 * fails too.
 */
// 24 is three dialects times two tables times four libraries, and 516 is every column of all six
// tables in each of the four. Nothing is lost to a crash here: the omissions that crash do so on
// official's side, and this check reads DRZL's alone.
const SELECT_REACH = { schemas: 24, keys: 516 };
const selectSchemas = new Set<string>();
let selectKeysInspected = 0;

const usedPresenceWaivers = new Set<string>();
const presenceWaived = new Map<string, Map<string, string>>();
const presenceAllowed = (dialect: string, lib: string, col: string, mode: string, signature: string) => {
  for (const key of [`${dialect}/${lib}/${col}`, `${dialect}/${col}`]) {
    if (!PRESENCE_ALLOWED[key]) continue;
    usedPresenceWaivers.add(key);
    const seen = presenceWaived.get(key) ?? new Map<string, string>();
    seen.set(`${mode}/${lib}`, signature);
    presenceWaived.set(key, seen);
    return PRESENCE_ALLOWED[key].why;
  }
  return undefined;
};

/**
 * Cross-generator gaps that follow from what each library can express, not from a defect in one
 * generator. Keyed `<dialect>/<column>` and carrying its reason, for the same reason ALLOWED is.
 */
/**
 * A difference between DRZL's own four generators that is deliberate.
 *
 * `modes` rather than three keys per column, because the same difference usually holds in all
 * three and a key per mode would say it three times and rot in three places. It is asserted
 * exactly, like every other ledger here: a mode that diverges and is not declared is a finding,
 * and a declared mode that does not diverge fails the run.
 */
type CrossWaiver = { modes: string[]; why: string; divergence: Record<string, string> };

const CROSS_ALLOWED: Record<string, CrossWaiver> = {
  // ArkType's string DSL has no recursive JSON value, so this generator emits
  // `number | object | string | boolean | null`, which takes NaN, Infinity and any object at all.
  // The other three build a real JSON value check. A capability difference between the libraries:
  // official `drizzle-orm/arktype` produces the same widening, which is why this shows up here and
  // not against official.
  //
  // The signature is what each of these actually suppresses, and it is identical on all seven:
  // five values, arktype alone accepting each. Before it was here, `crossAllowed` discarded every
  // row for its column whatever the rows said, so making DRZL's typebox `c_jsonb` reject `{}` was
  // absorbed and the stage still printed that all four generators agree on every column and value.
  'pg/c_json': { modes: ['select', 'insert', 'update'], why: "arktype's string DSL cannot state a recursive JSON value", divergence: { '*': `NaN: arktype accept, zod/valibot/typebox reject; Infinity: arktype accept, zod/valibot/typebox reject; Date: arktype accept, zod/valibot/typebox reject; Buffer: arktype accept, zod/valibot/typebox reject; Uint8Array: arktype accept, zod/valibot/typebox reject` } },
  'pg/c_jsonb': { modes: ['select', 'insert', 'update'], why: 'as pg/c_json', divergence: { '*': `NaN: arktype accept, zod/valibot/typebox reject; Infinity: arktype accept, zod/valibot/typebox reject; Date: arktype accept, zod/valibot/typebox reject; Buffer: arktype accept, zod/valibot/typebox reject; Uint8Array: arktype accept, zod/valibot/typebox reject` } },
  'pg/c_jsonb_typed': { modes: ['select', 'insert', 'update'], why: 'as pg/c_json', divergence: { '*': `NaN: arktype accept, zod/valibot/typebox reject; Infinity: arktype accept, zod/valibot/typebox reject; Date: arktype accept, zod/valibot/typebox reject; Buffer: arktype accept, zod/valibot/typebox reject; Uint8Array: arktype accept, zod/valibot/typebox reject` } },
  'mysql/m_json': { modes: ['select', 'insert', 'update'], why: 'as pg/c_json', divergence: { '*': `NaN: arktype accept, zod/valibot/typebox reject; Infinity: arktype accept, zod/valibot/typebox reject; Date: arktype accept, zod/valibot/typebox reject; Buffer: arktype accept, zod/valibot/typebox reject; Uint8Array: arktype accept, zod/valibot/typebox reject` } },
  'sqlite/s_text_json': { modes: ['select', 'insert', 'update'], why: 'as pg/c_json', divergence: { '*': `NaN: arktype accept, zod/valibot/typebox reject; Infinity: arktype accept, zod/valibot/typebox reject; Date: arktype accept, zod/valibot/typebox reject; Buffer: arktype accept, zod/valibot/typebox reject; Uint8Array: arktype accept, zod/valibot/typebox reject` } },
  'sqlite/s_blob_json': { modes: ['select', 'insert', 'update'], why: 'as pg/c_json', divergence: { '*': `NaN: arktype accept, zod/valibot/typebox reject; Infinity: arktype accept, zod/valibot/typebox reject; Date: arktype accept, zod/valibot/typebox reject; Buffer: arktype accept, zod/valibot/typebox reject; Uint8Array: arktype accept, zod/valibot/typebox reject` } },
  'sqlite/s_blob': { modes: ['select', 'insert', 'update'], why: 'as pg/c_json; a bare blob() is Drizzle json mode', divergence: { '*': `NaN: arktype accept, zod/valibot/typebox reject; Infinity: arktype accept, zod/valibot/typebox reject; Date: arktype accept, zod/valibot/typebox reject; Buffer: arktype accept, zod/valibot/typebox reject; Uint8Array: arktype accept, zod/valibot/typebox reject` } },
  // The four generators split on `Infinity` for an 8 byte float column whose database stores one,
  // and only since those columns stopped carrying a magnitude bound. That is not a difference in
  // what DRZL asked for: all four are handed the same column, with `integer: false` and no range,
  // and `z.number()` and `Type.Number()` refuse a non-finite number on their own while `v.number()`
  // and arktype's `number` accept one. Postgres stores and returns Infinity in `real` and `double
  // precision` alike, and a real SQLite 3.53.4 stores it in a `real` and hands it back, so valibot
  // and arktype are the two that agree with the database on both of those.
  //
  // No `real` entry: the float4 bound refuses Infinity in all four, so they agree there for a
  // reason that has nothing to do with the libraries.
  //
  // No MySQL entry, and that is a fix rather than an omission. `mysql/m_real` and `mysql/m_double`
  // sat here reading "as pg/c_double", which is the wrong arbiter for a MySQL column: measured on
  // 8.4.11 on the binary prepared path, `float`, `double` and `real` answer
  // ER_WARN_DATA_OUT_OF_RANGE for `Infinity` and `-Infinity` alike, so the two libraries that
  // accepted them were the two disagreeing with the database rather than the two agreeing with it.
  // The analyzer states that refusal now and valibot and arktype refuse it with it, so all four
  // generators agree on those two columns and there is nothing left to waive (BU).
  'sqlite/s_real': { modes: ['select', 'insert', 'update'], why: 'as pg/c_double', divergence: { '*': `Infinity: valibot/arktype accept, zod/typebox reject` } },
  // The same two splits on the nullable table, which is what says the wrapper each generator puts
  // round a nullable column does not change which library can express what.
  'pg/n_json': { modes: ['select', 'insert', 'update'], why: 'as pg/c_json', divergence: { '*': `NaN: arktype accept, zod/valibot/typebox reject; Infinity: arktype accept, zod/valibot/typebox reject; Date: arktype accept, zod/valibot/typebox reject; Buffer: arktype accept, zod/valibot/typebox reject; Uint8Array: arktype accept, zod/valibot/typebox reject` } },
  'mysql/m_n_json': { modes: ['select', 'insert', 'update'], why: 'as pg/c_json', divergence: { '*': `NaN: arktype accept, zod/valibot/typebox reject; Infinity: arktype accept, zod/valibot/typebox reject; Date: arktype accept, zod/valibot/typebox reject; Buffer: arktype accept, zod/valibot/typebox reject; Uint8Array: arktype accept, zod/valibot/typebox reject` } },
  'sqlite/s_n_json': { modes: ['select', 'insert', 'update'], why: 'as pg/c_json', divergence: { '*': `NaN: arktype accept, zod/valibot/typebox reject; Infinity: arktype accept, zod/valibot/typebox reject; Date: arktype accept, zod/valibot/typebox reject; Buffer: arktype accept, zod/valibot/typebox reject; Uint8Array: arktype accept, zod/valibot/typebox reject` } },
  /**
   * A split that exists on the nullable path and on no other, which is the whole reason this table
   * is here. ArkType's `number` refuses NaN, and `number | null` accepts it. Four measurements,
   * on arktype directly rather than through anything DRZL emits:
   *
   *   type('number')(NaN)                             rejected
   *   type('(number | null)')(NaN)                    accepted
   *   type('-100 <= number <= 100')(NaN)              rejected
   *   type('(-100 <= number <= 100 | null)')(NaN)     accepted
   *
   * So a bound does not hold it back and the union is what admits it. `number.integer | null` still
   * refuses NaN, which is why the nullable integer columns do not split.
   *
   * This is not DRZL asking for something odd, and the parity pass proves it: official's own
   * `drizzle-orm/arktype` produces the same acceptance, so `n_real` reports parity against official
   * on arktype while disagreeing with its three siblings here.
   *
   * The database is on arktype's side. Asked through PGlite: `NaN` inserts into `real` and into
   * `double precision`, and is refused by `integer` with 22P02. So the three that reject it are the
   * strict ones, exactly as with `Infinity` on the 8 byte floats above, and the honest description
   * of a Postgres float column still needs a union in every generator rather than a range.
   */
  // The NaN half is gone: arktype no longer lets one through a union arm, and MySQL and SQLite
  // store no NaN in any numeric column, so refusing it is right here where accepting it is
  // right on Postgres. What is left is the Infinity half, which is a different mechanism: an
  // unbounded `number` takes both infinities in valibot and arktype, in every mode.
  'sqlite/s_n_real': { modes: ['select', 'insert', 'update'], why: 'as pg/c_double on Infinity, which no bound holds back here', divergence: { '*': `Infinity: valibot/arktype accept, zod/typebox reject` } },
  // No bigint entry either, for the reason given in ALLOWED: arktype now bounds a bigint with a
  // narrow, so the four generators agree about `c_bigint_b`, `m_bigint_b` and `s_blob_bigint`.
  // No `c_char` entry. There was one, reading "zod and valibot count code points; TypeBox and
  // ArkType count UTF-16 units", and it had been dead since arktype and typebox were changed to
  // count code points as well. All four now emit a `[...v].length` predicate and agree on every
  // probe including astral text, so there is nothing to waive. It survived because the waiver was
  // marked used by the column merely existing; see the note at the crossAllowed call site.
};


/**
 * Differences between DRZL's own four generators that are defects rather than choices.
 *
 * Same shape and same both-directions assertion as CROSS_ALLOWED, kept apart from it for the
 * reason the round-trip stage keeps its two ledgers apart: that one says the difference is
 * intended, this one says it is a bug nobody has fixed yet. A pin here that stops firing fails the
 * run, which is how the fix reports itself.
 *
 * Every entry is the same defect. `coerceDates` is documented as accepting a date string or an
 * epoch number on write, and only the zod generator has a number branch at all; the other three
 * never had one. So every date and timestamp column takes an epoch number in one of four
 * generators and refuses it in the other three, on insert and on update alike, and which of your
 * schemas accepts `Date.now()` depends on which validator you chose.
 *
 * Invisible until this pass read the write modes (BB). It was noticed during an unrelated change
 * and confirmed by re-measuring on master rather than deduced from a diff, but nothing in the gate
 * could see it: select mode has no coercion, so all four agreed there. Filed as BC.
 */
const CROSS_DEFECTS: Record<string, CrossWaiver> = {};const usedCrossWaivers = new Set<string>();
// What each cross-generator waiver actually discarded, so the declaration can be compared with the
// run. `crossAllowed` used to return a boolean and the caller threw the rows away unread.
const crossWaived = new Map<string, string>();
const crossAllowed = (dialect: string, mode: string, col: string, rows: string[]) => {
  const key = `${dialect}/${col}`;
  const entry = CROSS_ALLOWED[key] ?? CROSS_DEFECTS[key];
  // A mode the entry does not name is not covered by it. Falling through to a finding is the
  // fail-closed direction: the alternative lets a waiver written for one mode silently absorb a
  // difference in another, which is the shape of the defect that made this pass read all three.
  if (!entry || !entry.modes.includes(mode)) return false;
  usedCrossWaivers.add(key);
  // The column name is stripped so the signature reads as the difference rather than as the row.
  crossWaived.set(`${key}/${mode}`, rows.map((r) => r.trim().replace(`${col} on `, '')).join('; '));
  return true;
};

/**
 * Two tables per dialect, not one.
 *
 * `matrix` holds every column type and every one of them is `notNull`, so for as long as it was the
 * only table here the comparison covered 0 nullable columns of 83. `nullable` is the other half,
 * and it is a separate table for the reason it is a separate table in the fixture: the arktype
 * output for a 40-column table of narrowed fields is at the edge of TS2589.
 */
const DIALECTS = [
  {
    name: 'pg',
    libs: ['zod', 'valibot', 'arktype', 'typebox'],
    tables: [
      {
        name: 'matrix',
        table: pgTable,
        mods: {
          zod: () => import('./gen/pg/zod/matrix.zod.js'),
          valibot: () => import('./gen/pg/valibot/matrix.valibot.js'),
          arktype: () => import('./gen/pg/arktype/matrix.arktype.js'),
          typebox: () => import('./gen/pg/typebox/matrix.typebox.js'),
        } as Record<string, () => Promise<any>>,
      },
      {
        name: 'nullable',
        table: pgNullable,
        mods: {
          zod: () => import('./gen/pg/zod/nullable.zod.js'),
          valibot: () => import('./gen/pg/valibot/nullable.valibot.js'),
          arktype: () => import('./gen/pg/arktype/nullable.arktype.js'),
          typebox: () => import('./gen/pg/typebox/nullable.typebox.js'),
        } as Record<string, () => Promise<any>>,
      },
    ],
  },
  {
    name: 'mysql',
    libs: ['zod', 'valibot', 'arktype', 'typebox'],
    tables: [
      {
        name: 'matrix',
        table: myTable,
        mods: {
          zod: () => import('./gen/mysql/zod/matrix.zod.js'),
          valibot: () => import('./gen/mysql/valibot/matrix.valibot.js'),
          arktype: () => import('./gen/mysql/arktype/matrix.arktype.js'),
          typebox: () => import('./gen/mysql/typebox/matrix.typebox.js'),
        } as Record<string, () => Promise<any>>,
      },
      {
        name: 'nullable',
        table: myNullable,
        mods: {
          zod: () => import('./gen/mysql/zod/nullable.zod.js'),
          valibot: () => import('./gen/mysql/valibot/nullable.valibot.js'),
          arktype: () => import('./gen/mysql/arktype/nullable.arktype.js'),
          typebox: () => import('./gen/mysql/typebox/nullable.typebox.js'),
        } as Record<string, () => Promise<any>>,
      },
    ],
  },
  {
    name: 'sqlite',
    libs: ['zod', 'valibot', 'arktype', 'typebox'],
    tables: [
      {
        name: 'matrix',
        table: sqTable,
        mods: {
          zod: () => import('./gen/sqlite/zod/matrix.zod.js'),
          valibot: () => import('./gen/sqlite/valibot/matrix.valibot.js'),
          arktype: () => import('./gen/sqlite/arktype/matrix.arktype.js'),
          typebox: () => import('./gen/sqlite/typebox/matrix.typebox.js'),
        } as Record<string, () => Promise<any>>,
      },
      {
        name: 'nullable',
        table: sqNullable,
        mods: {
          zod: () => import('./gen/sqlite/zod/nullable.zod.js'),
          valibot: () => import('./gen/sqlite/valibot/nullable.valibot.js'),
          arktype: () => import('./gen/sqlite/arktype/nullable.arktype.js'),
          typebox: () => import('./gen/sqlite/typebox/nullable.typebox.js'),
        } as Record<string, () => Promise<any>>,
      },
    ],
  },
];

const PREFIX = { select: 'Select', insert: 'Insert', update: 'Update' } as const;
let findings = 0;

/**
 * Every column of every fixture, in every library and every mode: 40 + 18 Postgres, 29 + 12 MySQL
 * and 14 + 13 SQLite columns, `matrix` and `nullable`, times four libraries, times three modes.
 *
 * Written out rather than derived from the arrays above, which would make it true by construction
 * and say nothing. The 0.4x stage has carried this since it was written; this pass had only the
 * per-pairing guard, which cannot see a whole dialect quietly dropping out.
 */
const EXPECTED_COMPARISONS = (41 + 18 + 31 + 12 + 14 + 13) * 4 * 3;
let totalCompared = 0;
/**
 * The same denominator for the presence axis, counted separately.
 *
 * Presence is asked of the object and the value pool is asked of the field, so one can go quiet
 * while the other keeps reporting: the two counters are what makes that visible. This one is the
 * whole point of the axis, because the state it guards against is the one that existed before it,
 * where the number of optionality comparisons was zero and every pairing still printed `parity`.
 */
let presenceCompared = 0;
/** Column pairings the presence axis could not read because a side crashed on the omission. */
let presenceCrashed = 0;
const presenceProblems: string[] = [];
// Which sides crashed on an omission, keyed `<dialect>/<library>/<column>`, held to THREW below.
const presenceThrew = new Map<string, { sides: Set<string>; modes: Set<string> }>();
const recordPresenceCrash = (key: string, side: string, mode: string) => {
  const seen = presenceThrew.get(key) ?? { sides: new Set<string>(), modes: new Set<string>() };
  seen.sides.add(side);
  seen.modes.add(mode);
  presenceThrew.set(key, seen);
};

/**
 * Which drizzle-orm this tree actually resolved.
 *
 * Off disk rather than through `require.resolve`, whose `exports` map has no `./package.json`
 * entry. Asserted before a column is touched, for the reason the 0.4x stage asserts its own: the
 * cross-major diff compared 0.45.2 with 0.45.2 for a day and was green throughout, because the
 * version was believed rather than read. This pass pins v1 in its install line and had no check at
 * all, so the same install-line typo would have made it a second 0.4x pass measuring nothing new.
 */
const drizzleVersion = JSON.parse(readFileSync('node_modules/drizzle-orm/package.json', 'utf8')).version;
if (typeof drizzleVersion !== 'string' || drizzleVersion.split('.')[0] !== '1') {
  console.error(`FAIL: this tree resolves drizzle-orm ${JSON.stringify(drizzleVersion)}, not the v1 line.`);
  console.error('      The 0.4x parity stage near the end of this script measures the other major,');
  console.error('      and two passes over the same one would compare it twice and pass.');
  process.exit(1);
}
console.log(`    drizzle-orm ${drizzleVersion}, with its own zod, valibot, arktype and typebox-legacy modules`);

for (const d of DIALECTS) {
  const loaded: Record<string, Record<string, any>> = {};
  for (const t of d.tables) {
    loaded[t.name] = {};
    for (const lib of d.libs) loaded[t.name][lib] = await t.mods[lib]();
  }

  for (const t of d.tables) {
  for (const mode of ['select', 'insert', 'update'] as const) {
    for (const libName of d.libs) {
      const off = OFFICIAL[libName]?.[mode];
      if (!off) continue;
      const lib = LIBS[libName];
      const official = off(t.table as never);
      const mine = loaded[t.name][libName][`${PREFIX[mode]}${t.name}Schema`];
      if (!mine) {
        console.log(`    ${d.name}/${libName}/${mode}: no ${PREFIX[mode]}${t.name}Schema exported`);
        findings++;
        continue;
      }

      // Column names come from the zod schema regardless of library: every generator emits the
      // same set, and zod is the one whose shape is trivially enumerable.
      const oShape = OFFICIAL.zod[mode](t.table as never).shape;
      const rows: string[] = [];
      let waivedCount = 0;
      // Columns where both sides yielded a field and the pool was actually pushed through them.
      // Printing the shape's column count says how many columns *exist*, which is not the same
      // number and stayed reassuring in a run that compared none of them.
      let compared = 0;

      for (const k of Object.keys(oShape)) {
        const o = safeField(lib, official, k);
        const m = safeField(lib, mine, k);
        if (!o && !m) {
          // Never a skip. Both sides absent means this column was measured by nothing, and
          // `safeField` returns undefined for a lookup that threw as well as for one that was
          // missing, so the quiet version of this branch reported parity on an exception.
          rows.push(`        ${k}: neither official nor DRZL yielded a field, so nothing was compared`);
          continue;
        }
        if (!m) {
          if (allowed(d.name, libName, k, mode, 'official has it, DRZL omits it')) { waivedCount++; continue; }
          rows.push(`        ${k}: official has it, DRZL omits it`);
          continue;
        }
        if (!o) {
          if (allowed(d.name, libName, k, mode, 'DRZL has it, official omits it')) { waivedCount++; continue; }
          rows.push(`        ${k}: DRZL has it, official omits it`);
          continue;
        }
        compared++;
        const looser: string[] = [];
        const tighter: string[] = [];
        // What official accepted, in pool order. Only read when DRZL accepted everything, where it
        // is the complement of the divergence and so names it exactly.
        const officialAccepted: string[] = [];
        let officialTook = false;
        let drzlTook = false;
        // Whether DRZL took the whole pool, which is what the derived signature rests on.
        let drzlAll = true;
        for (const [label, x] of POOL) {
          const a: Verdict = probe(lib, o, x);
          const b: Verdict = probe(lib, m, x);
          // A crash is not a verdict, so this value is not compared for this column. It is
          // recorded and held to the THREW list above instead, which is what keeps it from being
          // an absence that reads as agreement.
          if (a === 'threw' || b === 'threw') {
            if (a === 'threw') recordThrow(`${d.name}/${libName}/${k}`, 'official', mode, label);
            if (b === 'threw') recordThrow(`${d.name}/${libName}/${k}`, 'drzl', mode, label);
            // Not compared, and not unmeasured either: DRZL's answer is pinned against the crash
            // entry below and arbitrated against a real database wherever one runs for this
            // dialect. Dropping it here and doing nothing else is what let a null-accepting insert
            // schema on a NOT NULL column sit under a green line.
            recordCrashVerdict(`${d.name}/${libName}/${k}`, mode, label, b);
            continue;
          }
          if (a === 'accept') officialAccepted.push(label);
          officialTook ||= a === 'accept';
          drzlTook ||= b === 'accept';
          if (b !== 'accept') drzlAll = false;
          if (a !== b) (b === 'accept' ? looser : tighter).push(label);
        }
        // A column both sides reject every probe for agrees perfectly and proves nothing: the two
        // schemas could be a correct one and a broken one and this loop could not tell them apart.
        // It is not hypothetical. `c_varchar_enum` accepts only 'x' or 'y' and `m_year` only
        // 1901..2155, and the pool held no member of either, so two columns had been sitting in
        // this comparison contributing a confident nothing. Deliberately outside the waiver check
        // below: a waiver says a difference is fine, not that a column need not be measured.
        if (!officialTook && !drzlTook) {
          rows.push(
            `        ${k}: neither side accepts any pool value, so this column proves nothing.` +
              `\n          Add a value this column accepts to POOL.`
          );
          continue;
        }
        if (!looser.length && !tighter.length) continue;
        const signature = drzlAll
          ? allProbes(looser.length, officialAccepted)
          : `L: ${looser.join(', ')} | T: ${tighter.join(', ')}`;
        if (allowed(d.name, libName, k, mode, signature)) { waivedCount++; continue; }
        rows.push(
          `        ${k}:` +
            (looser.length ? `\n          DRZL accepts, official rejects: ${looser.join(', ')}` : '') +
            (tighter.length ? `\n          DRZL rejects, official accepts: ${tighter.join(', ')}` : '')
        );
      }

      /**
       * The other axis: whether each side lets the key be missing.
       *
       * Kept apart from the pool loop above rather than folded into it as one more probe, because
       * an absence is not a value and the signatures in ALLOWED are lists of values. Folding it in
       * would also move the `every probe official rejects` shorthand on every column that carries
       * it, which describes what the two schemas do with the pool.
       */
      const oPres = askPresence(lib, official, Object.keys(oShape));
      const mPres = askPresence(lib, mine, Object.keys(oShape));
      const readSide = (r: typeof oPres, side: string) => {
        for (const k of r.barren) {
          const key = `${d.name}/${libName}/${k}`;
          if (PRESENCE_BARREN[key]) { usedBarren.add(key); continue; }
          presenceProblems.push(
            `${d.name}/${t.name}/${mode}/${libName} ${side} accepts no pool value for ${k}, so no ` +
              'object satisfying it can be built, and nothing declares that'
          );
        }
        // A control that failed with no barren column behind it is a state nothing here explains.
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
        // The absolute half, read off DRZL's side alone and before the two are compared: a select
        // schema that lets a key go missing is wrong even where official does the same thing, and
        // it is still wrong where official cannot answer at all. `pg/typebox/n_bit` on the 0.4x
        // pass is the second case: official crashes on that omission, so the comparison below has
        // no verdict to differ from and this line is the only thing that sees it.
        if (mode === 'select' && b) {
          // Counted where the check reads, so the two can never describe different sets.
          selectSchemas.add(`${d.name}/${t.name}/${libName}`);
          selectKeysInspected++;
          if (b === 'optional') {
            const key = `${d.name}/${libName}/${k}`;
            if (SELECT_OPTIONAL[key]) usedSelectOptional.add(key);
            else selectOptionalProblems.push(`${key}: DRZL's select schema lets this key be missing, and nothing declares it`);
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
        const signature = `official ${a}, DRZL ${b}`;
        if (presenceAllowed(d.name, libName, k, mode, signature)) { waivedCount++; continue; }
        rows.push(`        ${k}: the key is ${a} for official and ${b} for DRZL`);
      }

      totalCompared += compared;
      // A run that compared no column at all would otherwise print `parity` and pass. That is the
      // shape of failure this file has been bitten by most: the stage was green because it had
      // measured nothing, not because there was nothing to find.
      if (compared === 0) {
        rows.push('        no column was compared on both sides, so this pairing measured nothing');
      }

      console.log(
        `    ${d.name.padEnd(7)} ${t.name.padEnd(8)} ${libName.padEnd(8)} ${mode.padEnd(7)} ` +
          `${compared}/${Object.keys(oShape).length} cols compared  ${rows.length ? 'DIFFERS' : 'parity'}` +
          `${waivedCount ? ` (${waivedCount} waived)` : ''}`
      );
      if (rows.length) {
        console.log(rows.join('\n'));
        findings += rows.length;
      }
    }
  }
  }

  // Pass 2, on every dialect that has all four generators, which is now all three.
  //
  // All three modes, and it read `Select` and nothing else until a defect made the cost visible.
  // Three of the four generators accepted `'hello'` on a date column's insert schema while zod
  // refused it, which is precisely the internal inconsistency this pass exists to surface, and it
  // sat here silently because the divergence was write only. The file had even written the
  // limitation down, on the crash ledger, and demonstrated it by making the typebox Insert and
  // Update schemas accept `null` on a NOT NULL column and watching the run stay byte identical to
  // green. The observation was recorded and the consequence was not drawn (BB).
  if (d.libs.length === 4) {
    const disagreements: string[] = [];
    for (const mode of MODE_NAMES) {
    const Mode = mode[0].toUpperCase() + mode.slice(1);
    for (const t of d.tables) {
    // The mode's own column set, not select's. An insert schema drops generated columns, so
    // reading select's keys here would ask four generators about a field none of them emits and
    // report it as missing from all four.
    const oShape = (OFFICIAL.zod as any)[mode](t.table as never).shape;
    for (const k of Object.keys(oShape)) {
      const fields: Record<string, any> = {};
      for (const lib of d.libs) fields[lib] = safeField(LIBS[lib], loaded[t.name][lib][`${Mode}${t.name}Schema`], k);
      const found: string[] = [];
      const absent = Object.entries(fields).filter(([, f]) => !f).map(([n]) => n);
      if (absent.length) {
        found.push(`        ${k}: missing from ${absent.join(', ')}`);
      } else {
        for (const [label, x] of POOL) {
          // `undefined` is not asked here, and skipping it is not a gap: the presence axis above
          // asks the same question properly, of the object rather than of the field.
          //
          // Measured, because it produced 169 findings that were all representation and no
          // behaviour. An optional field is `z.optional(X)` in zod, valibot and arktype, so the
          // extracted field takes `undefined`; TypeBox marks optionality on the parent's property
          // and leaves `X` alone, so the extracted field refuses it. Both objects accept `{}`,
          // which is the fact that matters and the fact they agree on. Probing the field measures
          // where each library records optionality. It never showed on select because every
          // column there is required, so all four refused `undefined` and agreed by accident.
          if (label === 'undefined') continue;
          const verdicts = d.libs.map((n) => [n, probe(LIBS[n], fields[n], x)] as const);
          // A generator that crashed is not one that rejected. Recorded on the DRZL side, where
          // nothing is declared, so any crash out of DRZL's own output fails this script.
          for (const [n, r] of verdicts) {
            if (r === 'threw') recordThrow(`${d.name}/${n}/${k}`, 'drzl', mode, label);
          }
          const yes = verdicts.filter(([, r]) => r === 'accept').map(([n]) => n);
          const no = verdicts.filter(([, r]) => r === 'reject').map(([n]) => n);
          if (yes.length && no.length) {
            found.push(`        ${k} on ${label}: ${yes.join('/')} accept, ${no.join('/')} reject`);
          }
        }
      }
      if (!found.length) continue;
      // The waiver is consulted only once there is something for it to suppress. Asking first
      // marked the key used because the column exists in the fixture, which made the dead-waiver
      // check below true of `ALLOWED` and false of `CROSS_ALLOWED`: a waiver naming a real column
      // the four generators agree about sat there indefinitely, and `pg/c_char` was one.
      if (crossAllowed(d.name, mode, k, found)) continue;
      disagreements.push(...found.map((r) => r.replace(/^ {8}/, `        ${mode} `)));
    }
    }
    }
    // Printed rather than implied, because the line below used to claim universal agreement while
    // seven columns disagreed on five values each and were being discarded unread.
    const crossCols = [...crossWaived.keys()].filter((key) => key.startsWith(`${d.name}/`)).length;
    const crossHere = [...crossWaived.entries()]
      .filter(([key]) => key.startsWith(`${d.name}/`))
      .reduce((n, [, sig]) => n + sig.split('; ').length, 0);
    if (disagreements.length) {
      console.log(`    the four ${d.name} generators disagree with each other:`);
      console.log(disagreements.join('\n'));
      findings += disagreements.length;
    } else {
      console.log(
        `    all four ${d.name} generators agree with each other on every column and value, bar ` +
          `the ${crossHere} documented difference(s) on ${crossCols} column(s)`
      );
    }
  }
}

/**
 * The MySQL byte caps, bracketed rather than stepped past.
 *
 * Same stage as the 0.4x tree carries, and it is here because that one does not cover this pass:
 * it probes `src/gen-0-4x/mysql/*` against `drizzle-zod@0.8.3`, which is a different object twice
 * over. The v1 modules emit a character cap the 0.4x ones do not, and they are compared against
 * `drizzle-orm/zod`. A sentence in ALLOWED above used to say the 0.4x stage covered `mediumtext`
 * for this pass; it never did, and `m_mediumtext` was a live divergence sitting under a green
 * parity line the whole time.
 *
 * Two probes per column, not one. One string over the cap only ever proves the cap is below it, so
 * the single probe this replaced pinned `tinytext` to the interval [36, 257] rather than to 255:
 * 36 is the largest pool string under the cap and 257 is where a probe built out of three-byte
 * characters lands. Measured rather than reasoned, by moving the emitted cap and re-running: 257
 * and 36 both left this pass byte identical to green, 258 and 35 both failed it. The same
 * construction left `text` free over [400, 65537] and `mediumtext` over about 16.7 million values.
 *
 * The pair brackets it. `floor(cap/3)` three-byte characters plus `cap mod 3` ASCII ones is exactly
 * `cap` bytes and roughly a third of that in UTF-16 units, so DRZL has to take it; one more ASCII
 * character is exactly `cap + 1` bytes, so DRZL has to refuse it. Together they pin the byte cap to
 * a single value, and both stay far under any character cap, so neither is answering a question
 * about characters.
 *
 * A real MySQL 8.4.11 on a utf8mb4 client agrees with both halves, which is what makes them the
 * right expectations rather than today's behaviour written down: for `tinytext`, `text`, `blob` and
 * `mediumtext` alike, the at-cap string inserts and `octet_length` reads back exactly the cap,
 * while the one-byte-longer string fails with ERROR 1406 "Data too long".
 *
 * `longtext` has no probe at all, and CAP_COVERAGE below is where that is asserted rather than
 * described.
 *
 * `m_blob` is here and not on the 0.4x side because 0.45.2's mysql-core has no `blob` export, so
 * that fixture cannot carry the column.
 */
// Read off the runtime rather than written down, so a V8 with a different limit is described
// correctly instead of being asserted about.
const MAX_JS_STRING = constants.MAX_STRING_LENGTH;
const TEXT_CAPS: Record<string, number> = {
  m_tinytext: 255,
  m_text: 65535,
  m_mediumtext: 16777215,
  m_longtext: 4294967295,
  m_blob: 65535,
};

/**
 * Where each MySQL text column's byte cap is actually measured.
 *
 * Computed by this run and compared with the declaration in both directions, because a sentence
 * about who measures what is exactly the kind that goes quietly false. Two of them already have on
 * this branch, and the second was introduced by the fix for the first: one said the 0.4x stage
 * measured `mediumtext` for this pass, and its replacement said both pool-unreachable columns were
 * measured by the byte-cap stage. `m_longtext` is measured by nothing at all, and deleting every
 * one of its caps from all four generated modules in all three modes leaves both passes byte
 * identical to green.
 *
 * The two things that measure a cap do not measure the same amount of it, and the printed line used
 * to give each of them one word, so `the pool and the byte-cap stage` read as two measurements of
 * the cap when only one of them is. They are named apart now:
 *
 *   `separated`  the pool holds a string this column's byte cap refuses and its UTF-16 count does
 *                not, which is the only kind of string the parity comparison above can tell the two
 *                counts apart with. It does not pin the cap: moving `m_tinytext`'s emitted cap to
 *                254 or to 256 produces no failure from the pool at all, and its reach on that
 *                column starts at 400, where the 100-emoji probe stops being refused.
 *   `bracketed`  the pair below was built and pushed through, at the cap and one byte over, which
 *                does pin the cap to a single value.
 */
const CAP_COVERAGE: Record<string, string> = {
  m_tinytext: 'bracketed and separated',
  m_text: 'bracketed and separated',
  m_blob: 'bracketed and separated',
  m_mediumtext: 'bracketed only',
  m_longtext: 'neither',
};

const capProblems: string[] = [];
const capMeasured: string[] = [];
const capUnreachable: string[] = [];
{
  // The `matrix` table specifically: `m_tinytext` and its siblings are declared there, and the
  // `nullable` table's `m_n_tinytext` is a different column with its own cap. Named rather than
  // taken as the first table, so this stage cannot start measuring a different one by accident.
  const mysql = DIALECTS.find((d) => d.name === 'mysql');
  const mysqlMatrix = mysql?.tables.find((t) => t.name === 'matrix');
  if (!mysql || !mysqlMatrix) {
    capProblems.push('the MySQL matrix table is not in this pass, so no byte cap was measured');
  } else {
    const loaded: Record<string, any> = {};
    for (const lib of mysql.libs) loaded[lib] = await mysqlMatrix.mods[lib]();
    for (const [col, cap] of Object.entries(TEXT_CAPS)) {
      const wide = Math.floor(cap / 3);
      const rest = cap - wide * 3;
      const units = wide + rest;
      if (units + 1 > MAX_JS_STRING) {
        capUnreachable.push(`${col} (a probe needs ${units + 1} units, over this V8's ${MAX_JS_STRING})`);
        // UTF-8 spends at most 3 bytes per UTF-16 unit, checked over every code point, so no JS
        // string here can carry more than this many bytes. When that is under the cap the cap
        // cannot be exceeded at all, which is a stronger statement than this construction being
        // too long, and it is the one `longtext` is in. Anything else means a different
        // construction might reach the column and this list is hiding it.
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
      for (const mode of ['select', 'insert', 'update'] as const) {
        for (const libName of mysql.libs) {
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
              `DRZL ${over.m}. Expected both accepted and DRZL alone refusing the second, which is ` +
              'where MySQL 8.4.11 puts the boundary.'
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
  "    byte caps: 'bracketed' is probed at the cap and one byte over, which pins DRZL's cap to one" +
    " value; 'separated' is the pool holding a string the cap refuses on bytes and takes on" +
    ' characters, which tells the two counts apart without pinning the cap'
);
console.log(`    ${coverageSeen.join('; ')}`);
if (capProblems.length) {
  console.error('FAIL: a MySQL text column no longer separates a byte budget from a character');
  console.error('      count the way it is documented to:');
  for (const c of capProblems) console.error(`      ${c}`);
}

if (totalCompared !== EXPECTED_COMPARISONS) {
  const direction = totalCompared < EXPECTED_COMPARISONS ? 'fewer' : 'more';
  console.error(`FAIL: ${totalCompared} column comparisons, expected ${EXPECTED_COMPARISONS}.`);
  console.error(`      This run compared ${direction} columns than EXPECTED_COMPARISONS says.`);
  if (totalCompared < EXPECTED_COMPARISONS) {
    console.error('      A parity pass that measures fewer columns than it did yesterday is the');
    console.error('      failure this file has been bitten by most, so this is a stop. Find what');
    console.error('      stopped being compared before touching the constant.');
  } else {
    console.error('      A fixture grew. That is fine and it is not automatic: measure the new');
    console.error('      columns, put any difference in ALLOWED with its reason, and then update');
    console.error('      EXPECTED_COMPARISONS in this file to match.');
  }
}
console.log(`    ${totalCompared} column comparisons`);

// The presence axis, held to the same denominator. It is a separate counter because it is a
// separate question asked of a separate object, and because the state it exists to end is one where
// this number was zero and every pairing still printed `parity`.
if (presenceCompared + presenceCrashed + presenceUnreadable !== EXPECTED_COMPARISONS) {
  presenceProblems.push(
    `${presenceCompared} key-presence comparisons plus ${presenceCrashed} crashed and ` +
      `${presenceUnreadable} unreadable, which is not the ${EXPECTED_COMPARISONS} column pairings ` +
      'the value pool is pushed through'
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
console.log(
  `    ${selectKeysInspected} select key(s) across ${selectSchemas.size} schema(s) required, bar ` +
    `${Object.keys(SELECT_OPTIONAL).length} declared to let the key go missing: ` +
    Object.keys(SELECT_OPTIONAL).join(', ')
);
console.log(
  `    ${presenceCompared} key-presence comparisons asked of the object rather than the field, ` +
    `${presenceCrashed} where a side crashed on the omission and ${presenceUnreadable} with no ` +
    `object to ask about (${Object.keys(PRESENCE_BARREN).join(', ')})`
);

// The omission crashes, held to THREW from both ends, exactly as the value crashes are.
for (const [key, seen] of presenceThrew) {
  const e = THREW[key];
  if (!e) {
    presenceProblems.push(
      `${key}: ${[...seen.sides].sort().join('/')} crashed on the object with the key omitted in ` +
        `${[...seen.modes].sort().join(', ')}, and is in no list`
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
    presenceProblems.push(`THREW[${key}] declares absentModes ${e.absentModes.join(',')} and no omission crashed there`);
  }
}

/**
 * How many waivers run each way, counted from the map rather than stated in a sentence.
 *
 * `L:` is the half of a signature listing what DRZL accepts and official refuses, so a non-empty
 * one is a waiver where DRZL is the looser side. Comments in this file have claimed a number for
 * that more than once, and the count is printed below instead so a claim about it cannot go
 * stale: the float waivers added when the bounds moved to the database's were described as "the
 * only entries in either pass that run that way", and they are not, on either pass.
 *
 * The sentence that stood here restated the printed counts and the ratio between them, having
 * just said that writing them down was what went stale. The nullable twins on this branch
 * falsified every figure in it in one edit, so it is gone and the printed line is the answer.
 *
 * Being looser than official is not by itself a defect and this line is not a warning. Postgres
 * takes three emoji into a `char(3)`, a Uint8Array into a `bytea` and a uuid into a `uuid`, and
 * official refuses all three. What the gate holds is the sentence at the end of this file.
 */
const looserSide = (e: { divergence: Record<string, string> }) =>
  Object.values(e.divergence).some((s) => s.split('|')[0].replace(/^L:/, '').trim() !== '');
const looserWaivers = Object.values(ALLOWED).filter(looserSide).length;
// How many waivers state their divergence as a rejection count plus a complement rather than as a
// list, read off the declarations. Sentences in this file used to carry that number and the length
// of the list it replaces; adding five pool values made every one of them wrong in a single edit,
// so it is computed here instead. Zero on this pass today, and the line says so rather than a
// comment.
const SHORTHAND = /^every probe official rejects \((\d+) of them\), and official accepts only: (.*)$/;
const shorthandCols = Object.entries(ALLOWED)
  .filter(([, e]) => Object.values(e.divergence).some((d) => SHORTHAND.test(d)))
  .map(([k]) => k);
console.log(
  `    ${Object.keys(ALLOWED).length} documented divergence(s), ${looserWaivers} of them with ` +
    `DRZL accepting something official refuses, ${shorthandCols.length} stated as a rejection ` +
    `count and a complement${shorthandCols.length ? `: ${shorthandCols.join(', ')}` : ''}`
);

// A waiver that suppresses nothing is not harmless. It is a sentence claiming a divergence exists
// and is fine, sitting next to the divergences that really do, and the next person to widen this
// file reads it as covered ground. Every key above has to earn its place on this run or be
// deleted, which is also the only thing standing between this list and being used as a way to
// make a failure go away.
const deadWaivers = [
  ...Object.keys(ALLOWED).filter((k) => !usedWaivers.has(k)).map((k) => `ALLOWED[${k}]`),
  ...Object.keys(CROSS_ALLOWED).filter((k) => !usedCrossWaivers.has(k)).map((k) => `CROSS_ALLOWED[${k}]`),
  ...Object.keys(CROSS_DEFECTS).filter((k) => !usedCrossWaivers.has(k)).map((k) => `CROSS_DEFECTS[${k}]`),
  ...Object.keys(PRESENCE_ALLOWED)
    .filter((k) => !usedPresenceWaivers.has(k))
    .map((k) => `PRESENCE_ALLOWED[${k}]`),
];

// The exact divergence each waiver covers, compared with what it actually suppressed. Every
// pairing has to be claimed by exactly one declaration and match it character for character, and
// every declaration has to claim at least one pairing. This is what "suppressed something" cannot
// say: stripping the length caps off `m_tinytext` still suppresses something, just something else.
const waiverProblems: string[] = [];
// One routine for both maps, so the presence axis cannot end up held to a weaker rule than the
// value axis. The 0.4x pass had exactly that shape for a round: two ledgers side by side, one
// asserted in both directions and one only checked for additions.
const checkWaivers = (map: Record<string, Waiver>, seenAll: Map<string, Map<string, string>>, name: string) => {
for (const [key, seen] of seenAll) {
  const entry = map[key];
  // Which pairings carry the divergence, not only what it looks like. A signature alone is
  // satisfied by any non-empty subset: deleting the `m_tinytext` byte cap on insert and update
  // and leaving select alone left this pass green, four pairings matching where twelve should,
  // while a MySQL TINYTEXT insert schema took 400 bytes the server refuses.
  const gotLibs = [...new Set([...seen.keys()].map((x) => x.split('/')[1]))].sort().join(',');
  const gotModes = [...new Set([...seen.keys()].map((x) => x.split('/')[0]))].sort().join(',');
  const wantLibs = [...entry.libs].sort().join(',');
  const wantModes = [...entry.modes].sort().join(',');
  if (gotLibs !== wantLibs) waiverProblems.push(`${name}[${key}] declares libs ${wantLibs}, measured ${gotLibs}`);
  if (gotModes !== wantModes) waiverProblems.push(`${name}[${key}] declares modes ${wantModes}, measured ${gotModes}`);
  const excepted = entry.except ?? [];
  const wrongly = excepted.filter((x) => seen.has(x));
  if (wrongly.length) {
    waiverProblems.push(
      `${name}[${key}] excepts ${wrongly.join(', ')}, which diverged on this run. ` +
        `Remove the exception or the waiver is understating what it covers.`
    );
  }
  const wantPairings = entry.libs.length * entry.modes.length - excepted.length;
  if (seen.size !== wantPairings) {
    waiverProblems.push(
      `${name}[${key}] declares ${wantPairings} pairings, measured ${seen.size}: ` +
        [...seen.keys()].sort().join(', ')
    );
  }
  const claimed = new Set<string>();
  for (const [pairing, sig] of seen) {
    const hits = Object.keys(entry.divergence).filter((d) => pairingMatches(d, pairing));
    if (hits.length !== 1) {
      waiverProblems.push(
        `${name}[${key}] has ${hits.length} declarations for ${pairing}, needs exactly one. ` +
          `Measured there: ${sig}`
      );
      continue;
    }
    claimed.add(hits[0]);
    const want = entry.divergence[hits[0]];
    if (want === sig) continue;
    waiverProblems.push(
      `${name}[${key}] on ${pairing} declares\n        ${want}\n      and measured\n        ${sig}`
    );
  }
  for (const d of Object.keys(entry.divergence)) {
    if (!claimed.has(d)) waiverProblems.push(`${name}[${key}] declaration '${d}' matched no pairing`);
  }
}
};
checkWaivers(ALLOWED, waived, 'ALLOWED');
checkWaivers(PRESENCE_ALLOWED, presenceWaived, 'PRESENCE_ALLOWED');
if (waiverProblems.length) {
  console.error('FAIL: a waiver no longer covers the divergence it was written for. Re-measure it');
  console.error('      and update the signature, or delete it. A waiver that says only "something');
  console.error('      differs here" absorbs the next regression on the same column:');
  for (const w of waiverProblems) console.error(`      ${w}`);
}

// The crashes, held to the same rule from both ends. An undeclared one is a difference nobody
// looked at; a declared one that stopped happening is a sentence about something nobody can see.
// The cross-generator waivers, held to their signatures the same way. Identical mechanism, and it
// is here because the deferral that left it out last round turned out to be exploitable in exactly
// the way the previous one was.
const crossProblems: string[] = [];
for (const [keyMode, sig] of crossWaived) {
  const i = keyMode.lastIndexOf('/');
  const key = keyMode.slice(0, i);
  const mode = keyMode.slice(i + 1);
  const entry = CROSS_ALLOWED[key] ?? CROSS_DEFECTS[key];
  const want = entry.divergence[mode] ?? entry.divergence['*'];
  if (want === undefined) {
    crossProblems.push(`CROSS_ALLOWED[${key}] names mode ${mode} and declares no divergence for it`);
    continue;
  }
  if (want === sig) continue;
  crossProblems.push(`CROSS_ALLOWED[${key}] on ${mode} declares\n        ${want}\n      and measured\n        ${sig}`);
}
// The other direction: a declared mode that produced nothing to suppress.
for (const [key, entry] of [...Object.entries(CROSS_ALLOWED), ...Object.entries(CROSS_DEFECTS)]) {
  for (const mode of entry.modes) {
    if (!crossWaived.has(`${key}/${mode}`)) {
      crossProblems.push(`CROSS_ALLOWED[${key}] names mode ${mode}, which suppressed nothing on this run`);
    }
  }
}
if (crossProblems.length) {
  console.error('FAIL: a cross-generator waiver no longer covers what it was written for:');
  for (const c of crossProblems) console.error(`      ${c}`);
}

const throwProblems: string[] = [];
for (const [key, seen] of threwSeen) {
  const e = THREW[key];
  if (!e) {
    throwProblems.push(
      `${key}: ${[...seen.sides].join('/')} crashed on ${[...seen.values].sort().join(', ')} ` +
        `in ${[...seen.modes].sort().join(', ')}, and is in no list`
    );
    continue;
  }
  const got = { side: [...seen.sides].sort().join(','), modes: [...seen.modes].sort().join(','), values: [...seen.values].sort().join(',') };
  const want = { side: e.side, modes: [...e.modes].sort().join(','), values: [...e.values].sort().join(',') };
  for (const f of ['side', 'modes', 'values'] as const) {
    if (got[f] !== want[f]) throwProblems.push(`THREW[${key}] declares ${f} ${want[f]}, measured ${got[f]}`);
  }
}
for (const key of Object.keys(THREW)) {
  if (!threwSeen.has(key)) throwProblems.push(`THREW[${key}] saw no crash on this run`);
}

/**
 * What DRZL answered where official could not, held to the declaration in both directions.
 *
 * Without this a crashing official validator is a licence for DRZL to do anything on that value.
 * `pg/typebox/c_bit` is `bit({ dimensions: 3 }).notNull()`, and its Insert and Update schemas were
 * made to accept `null` with this pass staying byte identical to green.
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
    throwProblems.push(
      `THREW[${key}] declares ${want} crashed probe(s), measured ${seen.size}: ${[...seen.keys()].sort().join(', ')}`
    );
  }
  const claimed = new Set<string>();
  for (const [at, verdict] of seen) {
    const cut = at.indexOf('/');
    const hits = Object.keys(e.drzl).filter((decl) => declMatches(decl, at.slice(0, cut), at.slice(cut + 1)));
    if (hits.length !== 1) {
      throwProblems.push(`THREW[${key}].drzl has ${hits.length} declarations for ${at}, needs exactly one. Measured there: ${verdict}`);
      continue;
    }
    claimed.add(hits[0]);
    if (e.drzl[hits[0]] === verdict) continue;
    throwProblems.push(`THREW[${key}].drzl declares ${e.drzl[hits[0]]} on ${at}, measured ${verdict}`);
  }
  for (const decl of Object.keys(e.drzl)) {
    if (!claimed.has(decl)) throwProblems.push(`THREW[${key}].drzl declaration '${decl}' matched no crashed probe`);
  }
}

/**
 * And who says those answers are the right ones.
 *
 * A pinned verdict stops DRZL's behaviour moving unseen; it does not say the pinned value is
 * correct. A real Postgres does, for everything it can be asked: the table is built from the
 * fixture column's own `getSQLType()`, and its nullable twin has to take a NULL before the NOT NULL
 * twin's refusal counts as anything.
 *
 * An absence is asked as an absence, by leaving the column out of the insert, and not by binding a
 * NULL where it would have gone. It used to be classified unarbitrable on the ground that no
 * database can be handed one, which is false: `pool.ts` has the three-way measurement, and the
 * consequence of the false ground was that the `undefined` probe on every crash site went
 * unarbitrated for a reason that named the wrong obstacle.
 *
 * One reason for not arbitrating survives, and it is now checked against something outside the
 * branch that produces it: PGlite is a Postgres, so it cannot answer for the MySQL columns. The
 * engine reports its own name through `select version()`, so a run where this process did hold an
 * engine for that dialect fails here instead of printing the excuse. That is the one thing this
 * block could not previously do: the reason string and the gate were one expression, so the string
 * was computed and the reason was not checked at all.
 */
const arbiterProblems: string[] = [];
{
  // Every Postgres table in the comparison, not only `matrix`: a crash site on a `nullable` column
  // has to reach the same database this one does, and a lookup over one table would report it as a
  // column no DDL can be built for.
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
    // The pool's `undefined` is an absence, and it is carried to the database as one rather than
    // bound as a value. `absent` is what picks the statement that never names the column.
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
      // Asserted rather than only computed. The engine names itself, so the excuse is checked
      // against something outside the branch that writes it: wiring a MySQL in here and leaving
      // this declaration alone fails the run instead of reading as deliberate.
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
      // DRZL takes is a schema admitting a row the server will not. `ALLOWED` is read dialect-wide
      // here and a library-scoped waiver does not reach it, which is the fail-closed direction.
      if (a.verdict === 'refuse' && verdicts.includes('accept') && !ALLOWED[`${w.dialect}/${w.column}`]) {
        arbiterProblems.push(
          `${w.key}/${w.label}: postgres refuses ${asked} and DRZL accepts it, and no waiver names ` +
            `${w.dialect}/${w.column}`
        );
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
if (arbiterProblems.length) {
  console.error('FAIL: a crash site is no longer settled the way it is declared to be. A value');
  console.error('      official crashes on is still a value DRZL answers, and something has to');
  console.error('      say whether that answer is right:');
  for (const a of arbiterProblems) console.error(`      ${a}`);
}
console.log(
  `    ${[...threwSeen.values()].reduce((n, s) => n + s.at.size, 0)} probe(s) crashed ` +
    `instead of returning a verdict, on ${threwSeen.size} column(s) against ` +
    `${Object.keys(THREW).length} declared, with DRZL's own verdict on each pinned above`
);
if (throwProblems.length) {
  console.error('FAIL: a probe crashed where the list above does not say one does. A crash is not');
  console.error('      a verdict and must not be compared as one:');
  for (const t of throwProblems) console.error(`      ${t}`);
}
if (deadWaivers.length) {
  console.error('FAIL: these waivers suppressed nothing on this run, so they describe a');
  console.error('      divergence that no longer happens. Delete them rather than keeping a');
  console.error('      reason for something nobody can observe:');
  for (const k of deadWaivers) console.error(`      ${k}`);
}

if (findings) {
  console.error(`FAIL: ${findings} parity finding(s): a generated schema differs from the`);
  console.error('      first-party module on a value, and no waiver names that difference.');
  console.error('      Looser is not automatically wrong and this sentence used to say it was:');
  console.error('      Postgres takes three emoji into a char(3) and a Uint8Array into a bytea,');
  console.error('      and official refuses both. Ask the database which side is right, then put');
  console.error('      the answer in ALLOWED with its measurement, or fix the generator.');
}

if (selectOptionalProblems.length) {
  console.error("FAIL: a select schema lets a key go missing. A select row carries every column, so");
  console.error('      an optional key there is wrong however many libraries agree about it:');
  for (const p of selectOptionalProblems) console.error(`      ${p}`);
}
if (presenceProblems.length) {
  console.error('FAIL: the key-presence axis could not measure what it claims to. A column no side');
  console.error('      accepts a value for, or an object a side refuses despite being built from');
  console.error('      its own accepted values, is not a reading and must not be compared as one:');
  for (const p of presenceProblems) console.error(`      ${p}`);
}

// Counted separately and exited on together, so one run reports both rather than hiding the
// second behind the first. A dead waiver is not a looser schema and must not be described as one.
if (
  findings ||
  deadWaivers.length ||
  throwProblems.length ||
  arbiterProblems.length ||
  waiverProblems.length ||
  crossProblems.length ||
  capProblems.length ||
  presenceProblems.length ||
  selectOptionalProblems.length ||
  totalCompared !== EXPECTED_COMPARISONS
) {
  process.exit(1);
}
