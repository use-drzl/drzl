import {
  mysqlTable, mysqlEnum, text, varchar, char, int, tinyint, smallint, mediumint,
  bigint, serial, boolean, real, double, float, decimal, json, date, datetime,
  timestamp, time, year, binary, varbinary, blob, tinytext, mediumtext, longtext,
  check,
} from 'drizzle-orm/mysql-core';
import { sql } from 'drizzle-orm';

export const matrix = mysqlTable('matrix', {
  m_text: text().notNull(),
  m_tinytext: tinytext().notNull(),
  m_mediumtext: mediumtext().notNull(),
  m_longtext: longtext().notNull(),
  m_varchar: varchar({ length: 255 }).notNull(),
  m_char: char({ length: 4 }).notNull(),
  m_enum: mysqlEnum(['a', 'b', 'c']).notNull(),

  m_tinyint: tinyint().notNull(),
  m_smallint: smallint().notNull(),
  m_mediumint: mediumint().notNull(),
  m_int: int().notNull(),
  m_int_u: int({ unsigned: true }).notNull(),
  m_bigint_n: bigint({ mode: 'number' }).notNull(),
  m_bigint_b: bigint({ mode: 'bigint' }).notNull(),
  m_bigint_b_u: bigint({ mode: 'bigint', unsigned: true }).notNull(),
  m_serial: serial().notNull(),
  m_real: real().notNull(),
  m_double: double().notNull(),
  m_float: float().notNull(),
  m_decimal: decimal({ precision: 10, scale: 2 }).notNull(),

  m_bool: boolean().notNull(),
  m_json: json().notNull(),

  m_date: date({ mode: 'date' }).notNull(),
  m_date_s: date({ mode: 'string' }).notNull(),
  m_datetime: datetime({ mode: 'date' }).notNull(),
  m_ts: timestamp({ mode: 'date' }).notNull(),
  m_time: time().notNull(),
  m_year: year().notNull(),

  m_binary: binary({ length: 4 }).notNull(),
  m_varbinary: varbinary({ length: 16 }).notNull(),
  m_blob: blob().notNull(),
});

// The nullable path on MySQL. Same reasoning as the Postgres `nullable` table above, minus the
// arrays and the two Postgres-only shapes: MySQL has no array type, no point and no vector.
// `m_n_tinytext` is here because a byte cap and a NULL meet on it, which is the pairing the
// wrapping order can lose.
export const nullable = mysqlTable('nullable', {
  m_n_text: text(),
  m_n_varchar: varchar({ length: 10 }),
  m_n_tinytext: tinytext(),
  m_n_int: int(),
  m_n_float: float(),
  m_n_bigint: bigint({ mode: 'bigint' }),
  m_n_bool: boolean(),
  m_n_enum: mysqlEnum(['a', 'b', 'c']),
  m_n_json: json(),
  m_n_datetime: datetime({ mode: 'date' }),
  m_n_default: int().default(7),
  m_n_check: int(),
}, (t) => [check('m_n_check_c', sql`${t.m_n_check} BETWEEN 18 AND 100`)]);

// Every CHECK form the parser reads, in MySQL's spelling. No cardinality(): MySQL has no arrays.
export const checked = mysqlTable('checked', {
  k_min: int(),
  k_max: int(),
  k_lo: int(),
  k_between: int(),
  k_eq: int(),
  k_in_s: varchar({ length: 20 }),
  k_in_n: int(),
  k_len: varchar({ length: 50 }),
  k_pair_a: int(),
  k_pair_b: int(),
}, (t) => [
  check('k_min_c', sql`${t.k_min} >= 18`),
  check('k_max_c', sql`${t.k_max} <= 100`),
  check('k_lo_c', sql`${t.k_lo} > 0`),
  check('k_between_c', sql`${t.k_between} BETWEEN 5 AND 15`),
  check('k_eq_c', sql`${t.k_eq} = 7`),
  check('k_in_s_c', sql`${t.k_in_s} IN ('a', 'b', 'c')`),
  check('k_in_n_c', sql`${t.k_in_n} IN (1, 2, 3)`),
  check('k_len_c', sql`char_length(${t.k_len}) >= 3`),
  check('k_pair_c', sql`${t.k_pair_a} < ${t.k_pair_b}`),
]);

// The one question only a real MySQL settles: varchar(n) is n characters, and the TEXT family is
// a byte budget. Nothing in the schema says which, so it is measured rather than reasoned about.
export const limits = mysqlTable('limits', {
  l_varchar: varchar({ length: 10 }),
  l_tinytext: tinytext(),
  l_text: text(),
});
