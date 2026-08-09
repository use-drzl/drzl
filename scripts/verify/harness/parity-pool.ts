import * as v from 'valibot';
import { type } from 'arktype';
import { Value } from '@sinclair/typebox/value';

export const POOL: [string, unknown][] = [
  ['null', null], ['undefined', undefined], ['""', ''], ["'hello'", 'hello'],
  ['300-char', 'x'.repeat(300)], ['70k-char', 'x'.repeat(70000)], ['5-char', 'xxxxx'],
  // Astral-plane characters, where a code-point count and a UTF-16 `.length` disagree. Without
  // them the pool cannot see the difference, which is exactly how the `varchar(n)` bug survived:
  // Postgres counts characters for `varchar(n)`, so a 3-emoji string fits in a varchar(5) that
  // every library's `.max(5)` refuses.
  //
  // Both of these were once listed twice, under two comments saying that in two ways. See the
  // duplicate check below the pool.
  ['3 emoji', '\u{1F44D}\u{1F44D}\u{1F44D}'],
  ['5 emoji', '\u{1F44D}\u{1F44D}\u{1F44D}\u{1F44D}\u{1F44D}'],
  ["'not-a-uuid'", 'not-a-uuid'], ['uuid', '3f2504e0-4f89-11d3-9a0c-0305e82c3301'],
  ["'zzz'", 'zzz'], ["'a'", 'a'], ["'happy'", 'happy'],
  // A member of the `varchar({ enum: ['x', 'y'] })` fixture column. Without it the pool held no
  // value that column accepts, so both sides rejected all of it and the comparison agreed while
  // measuring nothing. The vacuity check in each pass is what found it.
  ["'x'", 'x'],
  ['0', 0], ['1', 1], ['1.5', 1.5], ['-1', -1], ['200', 200], ['40000', 40000],
  ['9000000', 9000000], ['2147483648', 2147483648], ['9007199254740993', 9007199254740993],
  // What a Postgres `real` at full magnitude comes back as over the text protocol, and the reason
  // the two 4 byte float columns below no longer carry the same bound.
  //
  // Every other number here is orders of magnitude away from a float4 edge, so nothing in this
  // pool could tell a bound at the largest float32 from one at the largest double Postgres
  // accepts. Those are different numbers: Postgres takes 268435456 representable doubles past the
  // float32 and stores the float32 for all of them, and this is one of them. A select schema
  // bounded at the float32 refused the row a `real` column had just handed back, which is the
  // defect this branch exists to remove, and it survived a green run of both parity passes and
  // 1400 ground-truth probes because no probe was within 30 orders of magnitude of the edge.
  //
  // It separates the two dialects as well as the two bounds: `pg/c_real` accepts it and
  // `mysql/m_float` does not, because a real MySQL 8.4 refuses it with
  // `Out of range value for column`.
  ['3.4028235e38', 3.4028235e38],
  // 1900 and 2500 sit either side of MySQL's YEAR range and nothing sat inside it, so `m_year`
  // was the same vacuous agreement as the enum above: rejected by both, proving nothing.
  ['1900', 1900], ['2000', 2000], ['2500', 2500], ['NaN', NaN], ['Infinity', Infinity],
  ['1n', 1n], ['2n**70n', 2n ** 70n], ['true', true], ['false', false],
  ['Date', new Date('2020-01-01T00:00:00Z')], ["'2020-01-01'", '2020-01-01'],
  ["'2020-01-01T00:00:00Z'", '2020-01-01T00:00:00Z'], ["'12:00:00'", '12:00:00'],
  ["'25:99:99'", '25:99:99'],
  ['{}', {}], ["{a:'s'}", { a: 's' }], ['[]', []], ["['a']", ['a']], ['[1,2]', [1, 2]],
  ["['happy']", ['happy']], ['[1,2,3]', [1, 2, 3]],
  // An array holding a value past its element's cap. Every array probe above holds something
  // short, so dropping an element's constraint looked identical to keeping it: two generators
  // stopped capping array elements and nothing here could tell.
  ['["11-char"]', ['x'.repeat(11)]], ['["3 emoji"]', ['\u{1F44D}\u{1F44D}\u{1F44D}']],
  // Two strings that separate a byte budget from a UTF-16 count, and the rule for when one exists.
  //
  // A probe separates a cap of N bytes from a cap of N UTF-16 units only if it is over N bytes and
  // not over N units. UTF-8 spends at most 3 bytes per UTF-16 unit, exhaustively: 1 byte for
  // U+0000..U+007F and 2 for U+0080..U+07FF, both one unit; 3 for U+0800..U+FFFF, one unit; 4 for
  // U+10000..U+10FFFF, which is two units and so 2 bytes per unit; and a lone surrogate encodes as
  // U+FFFD, 3 bytes for one unit. Checked over every code point rather than argued: the maximum
  // ratio is 3. So a separating probe needs more than N/3 units, and it has to be built out of
  // three-byte characters to be anywhere near that.
  //
  // 100 emoji is 200 units and 400 bytes, which separates 255. 22000 CJK is 22000 units and 66000
  // bytes, which separates 65535. Those are `tinytext` and `text`. `mediumtext` needs 5592406
  // units, a 10.7 MiB string that is far too heavy to push through every column of every pairing,
  // and the byte-cap stage in the 0.4x tree measures that one on its own instead. `longtext` needs
  // 1431655766 units against a maximum JS string of 536870888 on this V8, measured by bisection,
  // so no probe for it can exist at all.
  //
  // The sentence this replaced said a string long enough to cross those caps in bytes crosses them
  // in units too. That was generalised from the emoji, where bytes are twice units, and it is false
  // for every three-byte BMP character. It left two filed fields under a green line.
  //
  // A real MySQL 8 on a utf8mb4 client settles which count is the database's: `tinytext` refuses
  // the emoji string ("Data too long"), and `varchar(255)` takes it and reports `length` 400 with
  // `char_length` 100. So TINYTEXT's 255 is bytes and VARCHAR's 255 is characters, in one table.
  ['100 emoji', '\u{1F44D}'.repeat(100)],
  ['22000 cjk', '\u4E00'.repeat(22000)],
  ['Buffer', Buffer.from('ab')], ['Uint8Array', new Uint8Array([1, 2])],
  ["'999.999.999.999'", '999.999.999.999'], ["'10.0.0.1'", '10.0.0.1'],
  ['{x:1,y:2}', { x: 1, y: 2 }], ["'12.5'", '12.5'], ["'0101'", '0101'], ["'010'", '010'],
  // Five integers placed around the `nullable` fixture's `CHECK (col BETWEEN 18 AND 100)`: one
  // inside, one on each boundary, and one just outside each end.
  //
  // Without them a CHECK waiver is a signature no wrong bound can move. Measured rather than
  // feared: with the pool as it was, moving the emitted bound on the Postgres zod `n_check` column
  // from `.gte(18).lte(100)` to `.gte(1000000000).lte(2000000000)`, a range that column could never
  // hold, left the whole script at exit 0 with zero findings. Every other numeric member of this
  // pool is outside both ranges, so DRZL's accept set over the pool did not move.
  //
  // They are appended rather than filed with the other numbers so that adding them reorders no
  // existing signature: every list here is built in pool order.
  ['17', 17], ['18', 18], ['50', 50], ['100', 100], ['101', 101],
  ['4294967295', 4294967295], ['4294967296', 4294967296],
  ['-1n', -1n], ['18446744073709551615n', 18446744073709551615n],
  ['18446744073709551616n', 18446744073709551616n],
];

/**
 * The pool holds each probe once, enforced rather than asserted.
 *
 * `3 emoji` and `5 emoji` were each listed twice, added under two comments that say the same thing
 * two ways, so `POOL.length` read 59 over 57 distinct values. Nothing failed and nothing could:
 * two entries carrying the same value get the same verdict from every schema on every side, so a
 * duplicate cannot produce a disagreement. What it does instead is inflate the counts a ledger
 * declares, each of which is the length of a list built by walking this pool, and put a label into
 * an `L:` or `T:` list twice, where that reads as two different probes.
 *
 * Measured by removing the two and re-running both passes against the declarations they had:
 * 168 declared-against-measured mismatches on the 0.4x pass over 17 entries, 102 on the v1 pass
 * over 12, every one of them a count two lower or a list with a repeat gone. No verdict moved and
 * no summary count moved on either pass.
 *
 * Both halves are checked. A duplicate label makes two entries indistinguishable in a printed
 * signature even when their values differ, and a duplicate value is the inflation above even when
 * the labels differ.
 */
const poolKey = (x: unknown): string => {
  if (typeof x === 'bigint') return `bigint:${x}`;
  if (typeof x === 'number') return `number:${Object.is(x, -0) ? '-0' : String(x)}`;
  if (typeof x === 'string') return `string:${x}`;
  if (x instanceof Date) return `date:${x.getTime()}`;
  if (ArrayBuffer.isView(x)) return `bytes:${Array.from(x as Uint8Array).join(',')}`;
  return `${typeof x}:${JSON.stringify(x) ?? String(x)}`;
};
const repeated = (keys: string[]): string[] => [
  ...new Set(keys.filter((k, i) => keys.indexOf(k) !== i)),
];
{
  const labels = repeated(POOL.map(([label]) => label));
  const values = repeated(POOL.map(([, value]) => poolKey(value)));
  if (labels.length > 0 || values.length > 0) {
    throw new Error(
      `POOL holds duplicate entries, so every count taken off it is inflated. ` +
        `Repeated label(s): ${labels.join(', ') || 'none'}. ` +
        `Repeated value(s): ${values.map((k) => k.slice(0, 40)).join(', ') || 'none'}.`,
    );
  }
}

export type Lib = { field: (s: any, k: string) => any; ok: (f: any, x: unknown) => boolean };

/**
 * How each library's schema is taken apart into one field per column, and checked.
 *
 * Both passes compare a column by extracting its field from each side and pushing the pool through
 * it, so anything a library keeps on the parent object rather than on the field is invisible here.
 * One such thing is known and it is TypeBox's optionality. Measured on official's 0.4x update
 * schema for `matrix`:
 *
 *   the property carries Symbol(TypeBox.Kind) and Symbol(TypeBox.Optional)
 *   Value.Check(objectSchema, {}) with the key omitted   true
 *   Value.Check(property, undefined)                     false
 *   deleting Symbol(TypeBox.Optional) from the property  changes no pool verdict at all
 *
 * So on TypeBox, and only on TypeBox, a required field and an optional one compare identically on
 * every probe. That is not a fear, it is a demonstrated exploit, run both ways: stripping every
 * `Type.Optional(` from `UpdatematrixSchema` in all three generated modules of both passes, 164
 * of them, left the whole script at exit 0. The same edit now exits 1 naming 82 columns, one for
 * every column of the three `matrix` tables the presence axis can read.
 *
 * `askPresence` below is what closes it, for all four libraries rather than for the one that had
 * the hole. It asks the *object* whether the key may be missing, which is a different question
 * from whether the field takes `undefined`: zod's `.optional()` answers yes to both, TypeBox's
 * `Type.Optional` answers yes only to the first, and a field typed `T | undefined` on a required
 * key answers yes only to the second.
 */
export const LIBS: Record<string, Lib> = {
  zod: { field: (s, k) => s.shape[k], ok: (f, x) => f.safeParse(x).success },
  valibot: { field: (s, k) => s.entries[k], ok: (f, x) => v.safeParse(f, x).success },
  arktype: { field: (s, k) => s.get(k), ok: (f, x) => !(f(x) instanceof type.errors) },
  typebox: { field: (s, k) => s.properties[k], ok: (f, x) => Value.Check(f, x) },
};

/**
 * What one schema said about one value. `threw` is not a verdict and neither pass may treat it as
 * one.
 *
 * This used to be a `catch { return false }`, which scored an exception as a rejection. Every one
 * of them comes from the same place, and the set is provable rather than sampled: official's
 * TypeBox module emits `{ type: 'RegExp', source, maxLength }` for a few columns, and TypeBox's
 * `maxLength` check reads `value.length` with no type guard, so `null` and `undefined` crash it
 * instead of failing it. Enumerated on both majors, the set of crashing columns and the set of
 * `type: 'RegExp'` columns are the same set, nine pairings on v1 and three on 0.4x:
 *
 *   v1     pg/c_bit, mysql/m_binary, mysql/m_varbinary, in all three modes
 *   0.4x   pg/c_bit alone, because that module emits a bare string for the binary columns
 *
 * So it is one upstream defect present on both majors rather than a difference between them. Zero
 * crashes come from arktype, which the sentence that used to stand here named, and zero from
 * anything DRZL emits on either major.
 *
 * Scoring those as rejections is not harmless: they fed the `looser` counts the ledger entries are
 * asserted against, so a swallowed crash was being reported as evidence.
 */
export type Verdict = 'accept' | 'reject' | 'threw';

export const probe = (lib: Lib, f: any, x: unknown): Verdict => {
  try {
    return lib.ok(f, x) ? 'accept' : 'reject';
  } catch {
    return 'threw';
  }
};

/** Whether an object schema lets a key be missing altogether. Not a verdict about a value. */
export type Presence = 'optional' | 'required';

/**
 * Does this schema require each key, asked of the object rather than of the extracted field?
 *
 * The field comparison above cannot ask it. A field carries the column's value rules; requiredness
 * lives on the parent, and on TypeBox it lives there exclusively, which is the hole this closes:
 * `Value.Check(property, undefined)` is false whether or not the property carries
 * `Symbol(TypeBox.Optional)`, so a TypeBox schema that got optionality wrong in either direction
 * gave every pool probe the same answer as a correct one.
 *
 * **An absence is asked as an absence.** The key is deleted from the object, not set to
 * `undefined`. Measured on TypeBox, where the two differ:
 * `Value.Check(Type.Object({ a: Type.Optional(Type.String()), b: Type.String() }), { b: 'x' })` is
 * true and so is the same object carrying `a: undefined`, while the field-level
 * `Value.Check(properties.a, undefined)` is false. Setting `undefined` would therefore be asking
 * the value question in the place the absence question belongs.
 *
 * The object is built from values this side accepts one at a time, and each side builds its own.
 * That is deliberate: two schemas can disagree so completely about a column's *type* that no pool
 * value satisfies both, which is the state `mysql/m_binary` is in on 0.4x, where DRZL wants a
 * Uint8Array and the official module wants a string. A shared object would then be refused by one
 * side for every key and the whole pairing would read as "requires everything" on both. The
 * question here is about the key, not about the value, so each side is asked with an object it
 * agrees is otherwise valid, and the control below is what says it agrees.
 *
 * Nothing here is ever skipped quietly. A column this side accepts no pool value for, and an object
 * this side refuses despite being built from its own accepted values, are both reported: the caller
 * fails on them rather than comparing an absence with an absence.
 *
 * A crash is not an answer here either, and it happens: official's TypeBox module emits
 * `{ type: 'RegExp', maxLength }` for a few columns, and its length check reads `value.length` with
 * no type guard, so the object check throws when the key is missing rather than reporting it
 * missing. Measured on `drizzle-typebox` 0.3.3 for `bit({ dimensions: 3 }).notNull()`: the full
 * object is accepted, and the same object with the key omitted throws
 * `Cannot read properties of undefined (reading 'length')`. Those columns come back in `crashed`
 * and the caller holds them to the same THREW ledger the value pool's crashes go to.
 *
 * `barren` is the other way this can fail to be readable, and it is a real state rather than a
 * hypothetical: official's TypeBox schema for a `uuid` column is `Type.String({ format: 'uuid' })`,
 * and TypeBox fails a format it has no entry for, so that field accepts nothing at all. No object
 * satisfying it exists, and where the column is also required no key of that object can be asked
 * about. The caller declares those and counts what they cost rather than reporting the pairing as
 * agreement.
 */
export type PresenceReading = {
  verdicts: Map<string, Presence>;
  /** Columns where this side crashed on the omission instead of answering. */
  crashed: string[];
  /** Columns this side accepts no pool value for, so no object satisfying it can be built. */
  barren: string[];
  /** Empty when the object built from this side's own accepted values was accepted. */
  control: string;
};

export const askPresence = (lib: Lib, schema: any, cols: string[]): PresenceReading => {
  const crashed: string[] = [];
  const barren: string[] = [];
  const verdicts = new Map<string, Presence>();
  const base: Record<string, unknown> = {};
  for (const k of cols) {
    let f: unknown;
    try {
      f = lib.field(schema, k);
    } catch {
      f = undefined;
    }
    if (!f) {
      barren.push(k);
      continue;
    }
    const hit = POOL.find(([, x]) => x !== undefined && probe(lib, f, x) === 'accept');
    if (!hit) {
      barren.push(k);
      continue;
    }
    base[k] = hit[1];
  }
  const control = probe(lib, schema, base);
  if (control !== 'accept') {
    return {
      verdicts,
      crashed,
      barren,
      control:
        `answers ${control} to an object built entirely from values it accepts one at a time, so ` +
        'removing a key from that object measures nothing',
    };
  }
  for (const k of cols) {
    if (!(k in base)) continue;
    const without = { ...base };
    delete without[k];
    const got = probe(lib, schema, without);
    if (got === 'threw') {
      crashed.push(k);
      continue;
    }
    verdicts.set(k, got === 'accept' ? 'optional' : 'required');
  }
  return { verdicts, crashed, barren, control: '' };
};

/**
 * A real Postgres, asked directly whether a column takes a value, and whether it takes that column
 * being left out of the insert altogether.
 *
 * Here because of the hole a crash left. A probe official crashes on cannot be compared, and it
 * used to be dropped, so DRZL's verdict on it was measured by nothing: making the v1 typebox
 * Insert and Update schemas for `c_bit` accept `null` on a `bit(3) NOT NULL` column left that
 * whole run byte identical to green. Pinning DRZL's verdict closes the hole; this is what settles
 * whether the pinned verdict is the right one, on the dialect that has an engine in this process.
 *
 * The DDL comes from the fixture's own column object rather than being written down here, so a
 * column that changes type changes what the database is asked about it.
 *
 * **A value and an absence are different questions and are asked differently.** A value is bound
 * as a parameter. An absence is a statement that never names the column, which is what an absent
 * field is; binding a JS `undefined` in its place asks the value question instead, because the
 * driver turns it into a NULL on the way to the server: a bound `undefined` comes back 23502, the
 * same answer as `null`. That was measured when this was written and is **not** re-measured on
 * every run, because the harness never binds `undefined`. It omits the column instead, which is the
 * question it wants asked. Both passes used to declare that no database could be handed an absence
 * at all, which was that one measurement about the driver written up as a fact about databases.
 *
 * Three tables per column, differing only in the constraint and the default. Each answer is read
 * only once its own control holds:
 *
 *   `probe_nn_N`    `c T not null`                 the subject
 *   `probe_null_N`  `c T`                          has to take a NULL and to take an omission
 *   `probe_def_N`   `c T not null default <lit>`   has to take an omission and still refuse a NULL
 *
 * Without the nullable twin, a refusal could as easily be a missing relation and would be scored as
 * a verdict about the value. Without the twin carrying a default, an omission and a NULL could not
 * be told apart at all: on `bit(3) not null` they give the same SQLSTATE, so the run would be
 * reporting the NULL answer under the absence's name. Measured, not supposed:
 *
 *   an insert into a table that does not exist        42P01
 *   NULL into bit(3) not null                         23502
 *   the column omitted, bit(3) not null               23502
 *   a bit string of the wrong width                   22026
 *   NULL into the nullable twin                       accepted
 *   the column omitted on the nullable twin           accepted
 *   the column omitted on the twin with a default     accepted, and the default is what is stored
 *   NULL into the twin with a default                 23502
 *
 * So a refusal carries its SQLSTATE rather than being a boolean, "refused by the constraint" is a
 * different answer from "refused by the type", and "refused because nothing supplied it" is a
 * different answer from both, on the same column type.
 *
 * The default is not written down either. The first pool value the type accepts is read back
 * through `quote_literal(c::text)` and cast to the column's own type, so a column no pool value
 * fits reports that it has no twin carrying a default rather than quietly losing the control.
 *
 * `engine` is the engine's own answer to `select version()`. A caller that declares a probe
 * unarbitrable for want of an engine then has something independent of its own branch to check
 * that reason against.
 */
export type DbProbe = { key: string; sqlType: string; notNull: boolean; label: string; absent: boolean; value: unknown };
export type DbAnswer = { verdict: 'accept' | 'refuse'; code: string; control: string };
export type DbReply = { engine: string; answers: Map<string, DbAnswer> };

export const askPostgres = async (probes: DbProbe[]): Promise<DbReply> => {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = new PGlite();
  const answers = new Map<string, DbAnswer>();
  let engine = 'unknown';
  try {
    const version = (await db.query<{ version: string }>('select version()')).rows[0]?.version ?? '';
    engine = /^PostgreSQL\b/.test(version) ? 'pg' : `not a Postgres: ${version.split(' ')[0] || 'unnamed'}`;
    const send = async (sql: string, params: unknown[]): Promise<{ verdict: 'accept' | 'refuse'; code: string }> => {
      try {
        await db.query(sql, params);
        return { verdict: 'accept', code: '' };
      } catch (e: unknown) {
        // A refusal with no SQLSTATE did not come from Postgres, so it is not reported as one.
        const code = (e as { code?: unknown } | null)?.code;
        return { verdict: 'refuse', code: typeof code === 'string' && code ? code : 'no SQLSTATE' };
      }
    };
    const withValue = (table: string, value: unknown) => send(`insert into ${table} (c, k) values ($1, 1)`, [value]);
    // The column is not named at all, which is the whole reason `k` is there: an insert has to
    // still be an insert once `c` is left out of it.
    const omitting = (table: string) => send(`insert into ${table} (k) values (1)`, []);

    const tables = new Map<string, { nn: string; nullable: string; dflt: string; noDflt: string }>();
    for (const p of probes) {
      if (tables.has(p.key)) continue;
      const n = tables.size;
      const t = { nn: `probe_nn_${n}`, nullable: `probe_null_${n}`, dflt: `probe_def_${n}`, noDflt: '' };
      // The subject carries the fixture column's own `notNull`, not a fixed `not null`. Every crash
      // site was on a `notNull` column until a nullable one arrived, and a nullable subject asked
      // about as a NOT NULL one answers 23502 to a NULL the column really does take, which reads as
      // "postgres refuses it and DRZL accepts it" for a schema that is right. The twins below stay
      // as they are: they are controls on the constraint, not on the column.
      await db.exec(
        `create table ${t.nn} (c ${p.sqlType}${p.notNull ? ' not null' : ''}, k int); ` +
          `create table ${t.nullable} (c ${p.sqlType}, k int)`
      );
      let lit: string | null = null;
      for (const [, x] of POOL) {
        if (x === null || x === undefined) continue;
        if ((await send(`insert into ${t.nullable} (c, k) values ($1, 0)`, [x])).verdict !== 'accept') continue;
        const q = await db.query<{ q: string | null }>(`select quote_literal(c::text) as q from ${t.nullable} where k = 0`);
        lit = q.rows[0]?.q ?? null;
        await db.exec(`delete from ${t.nullable}`);
        break;
      }
      if (lit === null) {
        t.noDflt =
          `no pool value is a ${p.sqlType}, so no twin carrying a default could be built and an ` +
          'omission cannot be told apart from a NULL here';
      } else {
        const built = await send(`create table ${t.dflt} (c ${p.sqlType} not null default ${lit}::${p.sqlType}, k int)`, []);
        if (built.verdict !== 'accept') {
          t.noDflt =
            `${p.sqlType} would not take ${lit} as a default (${built.code}), so an omission cannot ` +
            'be told apart from a NULL here';
        }
      }
      tables.set(p.key, t);
    }
    for (const p of probes) {
      const t = tables.get(p.key)!;
      if (p.absent) {
        const twinOmit = await omitting(t.nullable);
        const dfltOmit = t.noDflt ? null : await omitting(t.dflt);
        const dfltNull = t.noDflt ? null : await withValue(t.dflt, null);
        const got = await omitting(t.nn);
        answers.set(`${p.key}/${p.label}`, {
          verdict: got.verdict,
          code: got.code,
          control: twinOmit.verdict !== 'accept'
            ? `the nullable twin of ${p.sqlType} refused an insert that never names the column (${twinOmit.code}), so this table cannot isolate the constraint`
            : t.noDflt
              ? t.noDflt
              : dfltOmit!.verdict !== 'accept'
                ? `the twin of ${p.sqlType} carrying a default refused the same omission (${dfltOmit!.code}), so an omission is not reaching a default here`
                : dfltNull!.verdict !== 'refuse'
                  ? `the twin of ${p.sqlType} carrying a default took an explicit NULL, so this run cannot tell an omission apart from a NULL`
                  : '',
        });
        continue;
      }
      const control = await withValue(t.nullable, null);
      const got = await withValue(t.nn, p.value);
      answers.set(`${p.key}/${p.label}`, {
        verdict: got.verdict,
        code: got.code,
        control:
          control.verdict === 'accept'
            ? ''
            : `the nullable twin of ${p.sqlType} refused a NULL (${control.code}), so this table cannot isolate the constraint`,
      });
    }
  } finally {
    await db.close();
  }
  return { engine, answers };
};
