import {
  pgTable, pgEnum, text, varchar, char, uuid, integer, smallint, bigint, serial,
  boolean, real, doublePrecision, numeric, decimal, json, jsonb, date, timestamp,
  time, interval, bytea, inet, cidr, macaddr, point, line, geometry, bit, vector,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const moodEnum = pgEnum('mood', ['happy', 'sad', 'neutral']);

export const matrix = pgTable('matrix', {
  // --- text family ---
  c_text: text().notNull(),
  c_varchar: varchar({ length: 255 }).notNull(),
  c_char: char({ length: 4 }).notNull(),
  c_uuid: uuid().notNull(),
  c_text_enum: text({ enum: ['a', 'b', 'c'] }).notNull(),
  c_varchar_enum: varchar({ length: 10, enum: ['x', 'y'] }).notNull(),

  // --- numeric family ---
  c_int: integer().notNull(),
  c_smallint: smallint().notNull(),
  c_bigint_n: bigint({ mode: 'number' }).notNull(),
  c_bigint_b: bigint({ mode: 'bigint' }).notNull(),
  c_bigint_s: bigint({ mode: 'string' }).notNull(),
  c_serial: serial().notNull(),
  c_real: real().notNull(),
  c_double: doublePrecision().notNull(),
  c_numeric: numeric({ precision: 10, scale: 2 }).notNull(),
  c_numeric_n: numeric({ precision: 10, scale: 2, mode: 'number' }).notNull(),
  c_decimal: decimal().notNull(),

  // --- boolean ---
  c_bool: boolean().notNull(),

  // --- enum ---
  c_enum: moodEnum().notNull(),

  // --- json ---
  c_json: json().notNull(),
  c_jsonb: jsonb().notNull(),
  c_jsonb_typed: jsonb().$type<{ a: string }>().notNull(),

  // --- temporal ---
  c_date_d: date({ mode: 'date' }).notNull(),
  c_date_s: date({ mode: 'string' }).notNull(),
  c_ts_d: timestamp({ mode: 'date' }).notNull(),
  c_ts_s: timestamp({ mode: 'string' }).notNull(),
  c_time: time().notNull(),
  c_interval: interval().notNull(),

  // --- arrays ---
  c_text_arr: text().array().notNull(),
  // A capped element inside an array. Without one, dropping the element's cap looked identical to
  // keeping it: every array in this fixture held an uncapped type.
  c_varchar_arr: varchar({ length: 10 }).array().notNull(),
  c_int_arr: integer().array().notNull(),
  c_enum_arr: moodEnum().array().notNull(),

  // --- binary / network / geometry / vector ---
  // Deleted from the 0.4x fixture by a line match on this column's name. No comment near it may
  // name the type without that prefix: such a line survives the delete and fails the check.
  c_bytea: bytea().notNull(),
  c_inet: inet().notNull(),
  c_cidr: cidr().notNull(),
  c_macaddr: macaddr().notNull(),
  c_point: point().notNull(),
  c_line: line().notNull(),
  c_geometry: geometry().notNull(),
  c_bit: bit({ dimensions: 3 }).notNull(),
  c_vector: vector({ dimensions: 3 }).notNull(),
});

// Literal column defaults, which `applyDefaults` claims to reproduce in the insert schema. The
// falsy ones are the point: 0, false and '' are what a truthiness test drops, and a dropped
// default is invisible until a row arrives with a different value than the database would have
// written.
export const defaulted = pgTable('defaulted', {
  d_int: integer().default(42),
  d_zero: integer().default(0),
  d_neg: integer().default(-1),
  d_text: text().default('hello'),
  d_empty: text().default(''),
  d_bool_true: boolean().default(true),
  d_bool_false: boolean().default(false),
  d_real: doublePrecision().default(1.5),
  d_enum: moodEnum().default('sad'),
});

/**
 * Nullable arrays, which every array in `matrix` being `notNull` meant nothing had ever emitted.
 *
 * A nullable array renders differently enough to break code that assumed `T[]`: the arktype
 * generator recovered an array's element by stripping a trailing `[]`, and `(T[] | null)` has
 * none, so the whole union became the element and `.array()` wrapped it. That output refused
 * `null` and `['ab']`, accepted `[['ab']]`, and for the bigint one did not compile at all. A
 * capped or bounded element is what makes the shape reachable: an unconstrained column emits a
 * plain DSL string and never goes near that code.
 *
 * Its own table rather than two more columns on `matrix`, because the arktype output for a
 * 40-column table of narrowed fields is already at the edge of TS2589, and two more tipped it
 * over. That defect is reported; provoking it here would only hide these columns behind it.
 */
export const arrays = pgTable('arrays', {
  a_varchar_arr_null: varchar({ length: 10 }).array(),
  a_bigint_arr_null: bigint({ mode: 'bigint' }).array(),
});

/**
 * The nullable path, which is what most real schemas are made of and which no differential
 * comparison had ever looked at: every column of `matrix` is `notNull`, so neither pass compared
 * a single nullable column on any of the three dialects. The zero is the whole claim, and the
 * widths this sentence used to write beside it were the v1 pass's alone: the 0.4x pass deletes
 * from this fixture and from the MySQL one every column whose type 0.4x has no export for, so it
 * is narrower on two of the three dialects. Stated as a zero on both passes now, which is the
 * part that is true of both. (No type name here: a comment in this file naming one that the 0.4x
 * stage strips survives the strip and fails its check, which is what happened to this sentence.)
 *
 * Every generator emits a different construction for a nullable column, and each of them is a
 * place a constraint can be lost: zod appends `.nullable()` after the refinement, valibot wraps
 * in `v.nullable`, arktype builds a `(T | null)` union whose narrow has to guard the null itself,
 * and TypeBox emits `Type.Union([T, Type.Null()])`. None of those had been compared with the
 * first-party module for any column.
 *
 * Its own table rather than more columns on `matrix`, for the reason `arrays` above has one: the
 * arktype output for a 40-column table of narrowed fields is already at the edge of TS2589.
 *
 * The combinations are chosen rather than sampled. A default and a CHECK, because both attach to
 * the column and both have to survive being wrapped; an array and an enum, because both are
 * rebuilt rather than wrapped; and one column of each `shape` the analyzer distinguishes. Four of
 * the five are here, which is `json`, `tuple`, `numberVector` and, on v1 alone, `buffer`; the
 * SQLite table carries `buffer` on both majors and carries the fifth, `custom`.
 *
 * `n_geometry` and `n_bit` are the Postgres classes the 0.4x class-name path still cannot name,
 * and `n_vector` was a third until the pgvector arms landed. That is not incidental to the nullable
 * path: an unnamed column emits an unknown, and a *nullable* unknown is the one construction whose
 * key TypeBox lets go missing. The `notNull` twins sit in `matrix` and do not have that property.
 * `n_vector` stays in the fixture, because a column that is named now is still worth comparing.
 */
export const nullable = pgTable('nullable', {
  n_text: text(),
  n_varchar: varchar({ length: 10 }),
  n_int: integer(),
  n_real: real(),
  n_bigint: bigint({ mode: 'bigint' }),
  n_bool: boolean(),
  n_enum: moodEnum(),
  n_json: jsonb(),
  n_ts: timestamp({ mode: 'date' }),
  n_point: point(),
  n_geometry: geometry(),
  n_bit: bit({ dimensions: 3 }),
  n_vector: vector({ dimensions: 3 }),
  // Named for c_bytea so the 0.4x stage's edit takes both, on both of these lines.
  c_bytea_null: bytea(),
  n_text_arr: text().array(),
  n_enum_arr: moodEnum().array(),
  n_default: integer().default(7),
  n_check: integer(),
}, (t) => [check('n_check_c', sql`${t.n_check} BETWEEN 18 AND 100`)]);

// Every CHECK form the shared parser claims to understand, so Postgres can be asked whether the
// emitted constraint means the same thing. CHECK support is DRZL's main advantage over the
// first-party validators and until now it was verified only against its own emitted strings.
// Every column is nullable, so that each probe can insert one column and leave the rest out.
//
// This note sat above `defaulted` rather than above the table it describes, and it claimed the
// columns were "nullable on purpose, like the matrix table" when every column of `matrix` is
// notNull. Both halves are gone.
export const checked = pgTable('checked', {
  k_min: integer(),
  k_max: integer(),
  k_lo: integer(),
  k_hi: integer(),
  k_between: integer(),
  k_eq: integer(),
  k_in_s: text(),
  k_in_n: integer(),
  k_len: text(),
  k_len_max: text(),
  k_card: text().array(),
  k_pair_a: integer(),
  k_pair_b: integer(),
  k_bigint_s: bigint({ mode: 'string' }),
}, (t) => [
  check('k_min_c', sql`${t.k_min} >= 18`),
  check('k_max_c', sql`${t.k_max} <= 100`),
  check('k_lo_c', sql`${t.k_lo} > 0`),
  check('k_hi_c', sql`${t.k_hi} < 10`),
  check('k_between_c', sql`${t.k_between} BETWEEN 5 AND 15`),
  check('k_eq_c', sql`${t.k_eq} = 7`),
  check('k_in_s_c', sql`${t.k_in_s} IN ('a', 'b', 'c')`),
  check('k_in_n_c', sql`${t.k_in_n} IN (1, 2, 3)`),
  check('k_len_c', sql`length(${t.k_len}) >= 3`),
  check('k_len_max_c', sql`char_length(${t.k_len_max}) <= 5`),
  check('k_card_c', sql`cardinality(${t.k_card}) >= 2`),
  check('k_pair_c', sql`${t.k_pair_a} < ${t.k_pair_b}`),
  check('k_bigint_s_c', sql`${t.k_bigint_s} IN (1, 2)`),
]);
