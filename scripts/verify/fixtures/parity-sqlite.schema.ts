import { sqliteTable, text, integer, real, numeric, blob, check, customType } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const matrix = sqliteTable('matrix', {
  s_text: text().notNull(),
  s_text_len: text({ length: 50 }).notNull(),
  s_text_enum: text({ enum: ['a', 'b'] }).notNull(),
  s_text_json: text({ mode: 'json' }).notNull(),

  s_int: integer().notNull(),
  s_int_bool: integer({ mode: 'boolean' }).notNull(),
  s_int_ts: integer({ mode: 'timestamp' }).notNull(),
  s_int_ts_ms: integer({ mode: 'timestamp_ms' }).notNull(),

  s_real: real().notNull(),
  s_numeric: numeric().notNull(),

  s_blob: blob().notNull(),
  s_blob_buf: blob({ mode: 'buffer' }).notNull(),
  s_blob_json: blob({ mode: 'json' }).notNull(),
  s_blob_bigint: blob({ mode: 'bigint' }).notNull(),
});

// The fifth `shape` the analyzer distinguishes, and the only one a fixture can carry on both
// majors: a customType's JavaScript type exists at compile time and nowhere else, so the analyzer
// names it `custom` and every generator emits an unknown for it. That is what makes it worth
// carrying, because an unknown is the construction the key-presence axis is about.
const opaque = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'text';
  },
});

// The nullable path on SQLite. `s_n_blob` is the buffer shape, `s_n_json` the json one and
// `s_n_custom` the custom one; SQLite has no array, no tuple and no vector, and its enum is a text
// column carrying a member list. The `nullable` table on Postgres carries the other two shapes,
// and it carries the buffer one on v1 alone, since `c_bytea_null` leaves the 0.4x fixture with
// `c_bytea`.
export const nullable = sqliteTable('nullable', {
  s_n_text: text(),
  s_n_text_enum: text({ enum: ['a', 'b'] }),
  s_n_json: text({ mode: 'json' }),
  s_n_int: integer(),
  s_n_bool: integer({ mode: 'boolean' }),
  s_n_ts: integer({ mode: 'timestamp' }),
  s_n_real: real(),
  s_n_blob: blob({ mode: 'buffer' }),
  s_n_ts_ms: integer({ mode: 'timestamp_ms' }),
  s_n_custom: opaque(),
  s_n_bigint: blob({ mode: 'bigint' }),
  s_n_default: integer().default(7),
  s_n_check: integer(),
}, (t) => [check('s_n_check_c', sql`${t.s_n_check} BETWEEN 18 AND 100`)]);

// The same CHECK forms as the Postgres fixture, minus the ones SQLite has no equivalent for:
// no arrays and so no `cardinality()`, and no `char_length()`. SQLite enforces a CHECK exactly
// as strictly as Postgres does, whatever its type affinity does elsewhere, so it is a real second
// authority for this subsystem rather than a permissive one.
export const checked = sqliteTable('checked', {
  k_min: integer(),
  k_max: integer(),
  k_lo: integer(),
  k_between: integer(),
  k_eq: integer(),
  k_in_s: text(),
  k_in_n: integer(),
  k_len: text(),
  k_pair_a: integer(),
  k_pair_b: integer(),
}, (t) => [
  check('k_min_c', sql`${t.k_min} >= 18`),
  check('k_max_c', sql`${t.k_max} <= 100`),
  check('k_lo_c', sql`${t.k_lo} > 0`),
  check('k_between_c', sql`${t.k_between} BETWEEN 5 AND 15`),
  check('k_eq_c', sql`${t.k_eq} = 7`),
  check('k_in_s_c', sql`${t.k_in_s} IN ('a', 'b', 'c')`),
  check('k_in_n_c', sql`${t.k_in_n} IN (1, 2, 3)`),
  check('k_len_c', sql`length(${t.k_len}) >= 3`),
  check('k_pair_c', sql`${t.k_pair_a} < ${t.k_pair_b}`),
]);
