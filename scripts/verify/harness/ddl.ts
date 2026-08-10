/**
 * DDL matching src/schema.ts, column for column, asserted against the analysis so it cannot drift.
 *
 * Every column is nullable on purpose. Each probe inserts exactly one column, so a NOT NULL
 * sibling would fail the statement before the value under test was ever considered, and the whole
 * table would look like it rejected everything. Nullability is not what this measures: the
 * question is whether the column's *type* accepts the value.
 */
export const DDL = `
CREATE TYPE mood AS ENUM ('happy','sad','neutral');
CREATE TABLE matrix (
  c_text text,
  c_varchar varchar(255),
  c_char char(4),
  c_uuid uuid,
  c_text_enum text,
  c_varchar_enum varchar(10),
  c_int integer,
  c_smallint smallint,
  c_bigint_n bigint,
  c_bigint_b bigint,
  c_bigint_s bigint,
  c_serial integer,
  c_real real,
  c_double double precision,
  c_numeric numeric(10,2),
  c_numeric_n numeric(10,2),
  c_decimal numeric,
  c_bool boolean,
  c_enum mood,
  c_json json,
  c_jsonb jsonb,
  c_jsonb_typed jsonb,
  c_date_d date,
  c_date_s date,
  c_ts_d timestamp,
  c_ts_s timestamp,
  c_time time,
  c_interval interval,
  c_text_arr text[],
  c_varchar_arr varchar(10)[],
  c_int_arr integer[],
  c_enum_arr mood[],
  c_bytea bytea,
  c_inet inet,
  c_cidr cidr,
  c_macaddr macaddr,
  c_point point,
  c_line line,
  c_geometry point,
  c_bit bit(3),
  c_vector real[]
);

CREATE TABLE defaulted (
  d_int integer default 42,
  d_zero integer default 0,
  d_neg integer default -1,
  d_text text default 'hello',
  d_empty text default '',
  d_bool_true boolean default true,
  d_bool_false boolean default false,
  d_real double precision default 1.5,
  d_enum mood default 'sad'
);

CREATE TABLE checked (
  k_min integer CHECK (k_min >= 18),
  k_max integer CHECK (k_max <= 100),
  k_lo integer CHECK (k_lo > 0),
  k_hi integer CHECK (k_hi < 10),
  k_between integer CHECK (k_between BETWEEN 5 AND 15),
  k_eq integer CHECK (k_eq = 7),
  k_in_s text CHECK (k_in_s IN ('a', 'b', 'c')),
  k_in_n integer CHECK (k_in_n IN (1, 2, 3)),
  k_len text CHECK (length(k_len) >= 3),
  k_len_max text CHECK (char_length(k_len_max) <= 5),
  k_card text[] CHECK (cardinality(k_card) >= 2),
  k_pair_a integer,
  k_pair_b integer,
  k_bigint_s bigint CHECK (k_bigint_s IN (1, 2)),
  k_ne_s text CHECK (k_ne_s <> 'banned'),
  k_ne_n integer CHECK (k_ne_n <> 7),
  CONSTRAINT k_pair_c CHECK (k_pair_a < k_pair_b)
);
`;
