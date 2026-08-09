#!/usr/bin/env bash
#
# All four validator generators against drizzle-orm's own, on one table, for one pool of rows.
#
# `bench.sh` measures zod. This measures zod, valibot, arktype and typebox on the same fixture with
# the same rows, and then asks the question people choose TypeBox for: what a registered kind costs
# under `TypeCompiler`.
#
# Not part of CI, for the reason bench.sh gives: a benchmark on a shared runner measures the runner.
# Run by hand, and quote the numbers with the machine named and the spread printed rather than a
# single figure.
#
# What it measures:
#   1. how many of the constraints the database enforces each generated schema reproduces
#   2. how much each generated file weighs
#   3. throughput on rows that pass, rows that are mistyped, and rows that violate a CHECK
#   4. what a TypeBox registered kind costs, compiled and dynamic, against the same schema without
#   5. the same question for arktype's `narrow`, which is where its CHECKs live
#
# The operation is not the same operation in every row of the first table, and cannot be: zod and
# valibot return parsed output, arktype returns the value or an error object, and TypeBox's `Check`
# is a predicate that allocates nothing. The table names the operation; the numbers are comparable
# down a column and only roughly across one.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

REPS="${BENCH_REPS:-5}"
WINDOW_MS="${BENCH_WINDOW_MS:-400}"

echo "==> packing"
cd "$ROOT"
pnpm -r --filter='{packages/*}' exec pnpm pack --pack-destination "$WORK/tars" >/dev/null 2>&1

echo "==> installing into an empty project"
mkdir -p "$WORK/app/src" "$WORK/app/probe"
cd "$WORK/app"
npm init -y >/dev/null 2>&1
npm pkg set type=module >/dev/null
npm install --no-audit --no-fund --loglevel=error \
  "$WORK"/tars/*.tgz drizzle-orm@1.0.0-rc.4 zod valibot arktype @sinclair/typebox tsx >/dev/null

# The table bench.sh uses, unchanged, so a figure here can be read beside a figure there.
cat > src/schema.ts <<'SCHEMA'
import { pgTable, text, integer, varchar, boolean, timestamp, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const users = pgTable(
  'users',
  {
    id: integer().notNull(),
    email: varchar({ length: 255 }).notNull(),
    name: text().notNull(),
    age: integer().notNull(),
    tier: text().notNull(),
    score: integer().notNull(),
    active: boolean().notNull(),
    createdAt: timestamp({ mode: 'string' }).notNull(),
  },
  (t) => [
    check('age_c', sql`${t.age} >= 18`),
    check('score_c', sql`${t.score} BETWEEN 0 AND 100`),
    check('tier_c', sql`${t.tier} IN ('free', 'pro', 'team')`),
    check('name_c', sql`length(${t.name}) >= 2`),
  ]
);
SCHEMA

# Tables that differ in one thing: how many constraints need a predicate rather than a keyword.
# `count >= 0` and `n BETWEEN 0 AND 100` become `minimum`/`maximum`, which the compiler inlines.
# `length(a) >= 2` and a `varchar(n)` cap cannot: SQL counts characters and every JSON Schema
# keyword counts UTF-16 units, so those become registered kinds. The pairs price the difference.
cat > probe/schema.ts <<'PROBE'
import { pgTable, text, integer, varchar, boolean, timestamp, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

const base = {
  id: integer().notNull(),
  a: text().notNull(),
  b: text().notNull(),
  c: text().notNull(),
  d: text().notNull(),
  n1: integer().notNull(),
  n2: integer().notNull(),
  flag: boolean().notNull(),
  at: timestamp({ mode: 'string' }).notNull(),
};

export const k0 = pgTable('k0', base);
export const k1 = pgTable('k1', base, (t) => [check('k1_a', sql`length(${t.a}) >= 2`)]);
export const k2 = pgTable('k2', base, (t) => [
  check('k2_a', sql`length(${t.a}) >= 2`),
  check('k2_b', sql`length(${t.b}) >= 2`),
]);
export const k4 = pgTable('k4', base, (t) => [
  check('k4_a', sql`length(${t.a}) >= 2`),
  check('k4_b', sql`length(${t.b}) >= 2`),
  check('k4_c', sql`length(${t.c}) >= 2`),
  check('k4_d', sql`length(${t.d}) >= 2`),
]);
export const kw = pgTable('kw', base, (t) => [
  check('kw_n1', sql`${t.n1} BETWEEN 0 AND 100`),
  check('kw_n2', sql`${t.n2} >= 0`),
]);
export const cap1 = pgTable('cap1', { ...base, a: varchar({ length: 64 }).notNull() });
export const cap4 = pgTable('cap4', {
  ...base,
  a: varchar({ length: 64 }).notNull(),
  b: varchar({ length: 64 }).notNull(),
  c: varchar({ length: 64 }).notNull(),
  d: varchar({ length: 64 }).notNull(),
});
PROBE

cat > drzl.config.ts <<'CONFIG'
import { defineConfig } from '@drzl/cli/config';
export default defineConfig({
  schema: 'src/schema.ts',
  outDir: 'src/gen',
  generators: [
    { kind: 'zod', path: 'src/gen/zod' },
    { kind: 'valibot', path: 'src/gen/valibot' },
    { kind: 'arktype', path: 'src/gen/arktype' },
    { kind: 'typebox', path: 'src/gen/typebox' },
  ],
});
CONFIG

cat > probe.config.ts <<'CONFIG'
import { defineConfig } from '@drzl/cli/config';
export default defineConfig({
  schema: 'probe/schema.ts',
  outDir: 'probe/gen',
  generators: [
    { kind: 'typebox', path: 'probe/gen/typebox' },
    { kind: 'arktype', path: 'probe/gen/arktype' },
  ],
});
CONFIG

npx drzl generate --config drzl.config.ts >/dev/null
npx drzl generate --config probe.config.ts >/dev/null

cat > bench.ts <<'BENCH'
import { statSync } from 'node:fs';
import * as v from 'valibot';
import { type } from 'arktype';
import { Type, Kind, TypeRegistry } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { TypeCompiler } from '@sinclair/typebox/compiler';

import { SelectusersSchema as drzlZod } from './src/gen/zod/users.zod';
import { SelectusersSchema as drzlValibot } from './src/gen/valibot/users.valibot';
import { SelectusersSchema as drzlArktype } from './src/gen/arktype/users.arktype';
import { SelectusersSchema as drzlTypebox } from './src/gen/typebox/users.typebox';

import { createSelectSchema as officialZod } from 'drizzle-orm/zod';
import { createSelectSchema as officialValibot } from 'drizzle-orm/valibot';
import { createSelectSchema as officialArktype } from 'drizzle-orm/arktype';
// Not `drizzle-orm/typebox`: at 1.0.0-rc.4 that entry point imports the package `typebox`, which
// is TypeBox 1.x under a different name, and throws ERR_MODULE_NOT_FOUND on an install that has
// `@sinclair/typebox`. `typebox-legacy` is the entry point for the TypeBox everyone has today,
// and it is what DRZL's typebox generator emits against.
import { createSelectSchema as officialTypebox } from 'drizzle-orm/typebox-legacy';
import { users } from './src/schema';

import { Selectk0Schema as tbK0 } from './probe/gen/typebox/k0.typebox';
import { Selectk1Schema as tbK1 } from './probe/gen/typebox/k1.typebox';
import { Selectk2Schema as tbK2 } from './probe/gen/typebox/k2.typebox';
import { Selectk4Schema as tbK4 } from './probe/gen/typebox/k4.typebox';
import { SelectkwSchema as tbKw } from './probe/gen/typebox/kw.typebox';
import { Selectcap1Schema as tbCap1 } from './probe/gen/typebox/cap1.typebox';
import { Selectcap4Schema as tbCap4 } from './probe/gen/typebox/cap4.typebox';
import { Selectk0Schema as akK0 } from './probe/gen/arktype/k0.arktype';
import { Selectk1Schema as akK1 } from './probe/gen/arktype/k1.arktype';
import { Selectk4Schema as akK4 } from './probe/gen/arktype/k4.arktype';
import { Selectcap1Schema as akCap1 } from './probe/gen/arktype/cap1.arktype';

const REPS = Number(process.env.BENCH_REPS ?? 5);
const WINDOW_NS = BigInt(Number(process.env.BENCH_WINDOW_MS ?? 400)) * 1_000_000n;

const VALID = {
  id: 1,
  email: 'a@b.co',
  name: 'Ada',
  age: 30,
  tier: 'pro',
  score: 50,
  active: true,
  createdAt: '2026-08-02T00:00:00Z',
};

/** Rows the database refuses, each violating exactly one CHECK and otherwise well typed. */
const REJECTED = [
  { ...VALID, age: 17 },
  { ...VALID, score: 101 },
  { ...VALID, tier: 'enterprise' },
  { ...VALID, name: 'A' },
];

/** Wrong in a way every schema can see, so the failure path is the same failure. */
const MISTYPED = { ...VALID, id: 'x' };

/**
 * Sixteen distinct rows, rotated through by the measuring loop rather than one row reused.
 *
 * A compiled TypeBox check is a small pure function, and a pure function called in a loop on a
 * loop-invariant argument is something V8 may hoist out of the loop entirely. Measured: with one
 * constant row a nine-column schema with no constraints reported 883M checks a second, which is
 * 1.1ns, about five cycles for nine property tests. Rotating the argument reports 262M, which is
 * a number about the work rather than about the optimiser.
 */
// `createdAt` is the field varied, because it is the one column here under no constraint at all.
// Varying `id` instead put a number back into the mistyped row and quietly turned the whole
// mistyped column into a second measurement of the happy path: it reported 2995k against the
// accepted row's 3019k, which is what a duplicated measurement looks like.
const pool = <T extends Record<string, unknown>>(row: T): T[] =>
  Array.from(
    { length: 16 },
    (_, i) => ({ ...row, createdAt: `2026-08-02T00:00:${String(i).padStart(2, '0')}Z` }) as T
  );

const VALID_POOL = pool(VALID);
const MISTYPED_POOL = pool(MISTYPED);
const REJECTED_POOL = pool(REJECTED[0]);

/** Every result is accumulated, so no measured call is dead code. */
let SINK = 0;

function opsPerSecond(fn: (row: any) => boolean, rows: any[]): number {
  for (let i = 0; i < 2000; i++) SINK += fn(rows[i & 15]) ? 1 : 0;
  const start = process.hrtime.bigint();
  let n = 0;
  while (process.hrtime.bigint() - start < WINDOW_NS) {
    for (let i = 0; i < 256; i++) SINK += fn(rows[i & 15]) ? 1 : 0;
    n += 256;
  }
  return Math.round(n / (Number(process.hrtime.bigint() - start) / 1e9));
}

/** REPS independent measurements, reported as median and the range they fell in. */
function spread(fn: (row: any) => boolean, rows: any[]): string {
  const runs: number[] = [];
  for (let r = 0; r < REPS; r++) runs.push(opsPerSecond(fn, rows));
  runs.sort((a, b) => a - b);
  const k = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
  return `${k(runs[(runs.length - 1) >> 1])} [${k(runs[0])}..${k(runs[runs.length - 1])}]`;
}

/**
 * How long one `TypeCompiler.Compile` takes, in microseconds.
 *
 * A duration rather than a rate, because compilation happens once per schema per process. Twenty
 * compiles per repetition, because one is close enough to the clock's resolution to be noise.
 */
function compileMicros(schema: any): string {
  const runs: number[] = [];
  for (let r = 0; r < REPS; r++) {
    for (let i = 0; i < 5; i++) SINK += TypeCompiler.Compile(schema) ? 1 : 0;
    const start = process.hrtime.bigint();
    for (let i = 0; i < 20; i++) SINK += TypeCompiler.Compile(schema) ? 1 : 0;
    runs.push(Number(process.hrtime.bigint() - start) / 1000 / 20);
  }
  runs.sort((a, b) => a - b);
  return `${runs[(runs.length - 1) >> 1].toFixed(1)} [${runs[0].toFixed(1)}..${runs[runs.length - 1].toFixed(1)}]`;
}

/** `group` blanks a repeated first column and puts a line between groups; off for one-row-each. */
function table(head: string[], rows: string[][], group = false) {
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells: string[]) =>
    cells.map((c, i) => (i < 2 ? c.padEnd(w[i]) : c.padStart(w[i]))).join('  ');
  console.log(line(head));
  console.log('-'.repeat(w.reduce((a, b) => a + b, 0) + 2 * (w.length - 1)));
  let last = '';
  for (const r of rows) {
    if (group && last && r[0] !== last) console.log('');
    console.log(line([group && r[0] === last ? '' : r[0], ...r.slice(1)]));
    last = r[0];
  }
}

// ---------------------------------------------------------------- the four generators

type Runner = (row: unknown) => boolean;

const zodOf = (s: any): Runner => (row) => s.safeParse(row).success;
const valibotOf = (s: any): Runner => (row) => v.safeParse(s, row).success;
const arktypeOf = (s: any): Runner => (row) => !(s(row) instanceof type.errors);
const dynamicOf = (s: any): Runner => (row) => Value.Check(s, row);
const compiledOf = (s: any): Runner => {
  const c = TypeCompiler.Compile(s);
  return (row) => c.Check(row);
};

const CASES: Array<{ name: string; drzl: Runner; official: Runner; file: string | null }> = [
  {
    name: 'zod, safeParse',
    drzl: zodOf(drzlZod),
    official: zodOf(officialZod(users)),
    file: 'src/gen/zod/users.zod.ts',
  },
  {
    name: 'valibot, safeParse',
    drzl: valibotOf(drzlValibot),
    official: valibotOf(officialValibot(users)),
    file: 'src/gen/valibot/users.valibot.ts',
  },
  {
    name: 'arktype, call',
    drzl: arktypeOf(drzlArktype),
    official: arktypeOf(officialArktype(users)),
    file: 'src/gen/arktype/users.arktype.ts',
  },
  {
    name: 'typebox, Value.Check',
    drzl: dynamicOf(drzlTypebox),
    official: dynamicOf(officialTypebox(users)),
    file: 'src/gen/typebox/users.typebox.ts',
  },
  {
    name: 'typebox, TypeCompiler',
    drzl: compiledOf(drzlTypebox),
    official: compiledOf(officialTypebox(users)),
    file: null,
  },
];

const caught = (r: Runner, rows: unknown[]) => rows.filter((row) => !r(row)).length;

const genRows: string[][] = [];
for (const c of CASES) {
  genRows.push([
    c.name,
    'constraints the database enforces, reproduced',
    `${caught(c.drzl, REJECTED)}/4`,
    `${caught(c.official, REJECTED)}/4`,
  ]);
  if (c.file) {
    genRows.push([c.name, 'generated bytes for this table', String(statSync(c.file).size), 'n/a']);
  }
  genRows.push([
    c.name,
    'checks/sec, row accepted',
    spread(c.drzl, VALID_POOL),
    spread(c.official, VALID_POOL),
  ]);
  genRows.push([
    c.name,
    'checks/sec, row mistyped',
    spread(c.drzl, MISTYPED_POOL),
    spread(c.official, MISTYPED_POOL),
  ]);
  genRows.push([
    c.name,
    'checks/sec, row violates a CHECK',
    spread(c.drzl, REJECTED_POOL),
    spread(c.official, REJECTED_POOL),
  ]);
}

// ---------------------------------------------------------------- what a kind costs

const ROW_POOL = Array.from({ length: 16 }, (_, i) => ({
  id: i + 1,
  a: 'alpha'.repeat((i % 3) + 1),
  b: 'bravo'.repeat((i % 4) + 1),
  c: 'charlie',
  d: 'delta',
  n1: i % 100,
  n2: i + 7,
  flag: i % 2 === 0,
  at: '2026-08-02T00:00:00Z',
}));
const BAD_POOL = ROW_POOL.map((r) => ({ ...r, flag: 'yes' as any }));

const PLAIN = {
  id: Type.Integer({ minimum: -2147483648, maximum: 2147483647 }),
  a: Type.String(),
  b: Type.String(),
  c: Type.String(),
  d: Type.String(),
  n1: Type.Integer({ minimum: -2147483648, maximum: 2147483647 }),
  n2: Type.Integer({ minimum: -2147483648, maximum: 2147483647 }),
  flag: Type.Boolean(),
  at: Type.String(),
};

// Two controls DRZL never emits, to split what a kind costs into the dispatch out of the compiled
// function and the predicate the dispatch then runs.
TypeRegistry.Set('DrzlBenchTrivial', () => true);
TypeRegistry.Set('DrzlBenchFast', (schema: any, value: any) => schema.assert(value));

const trivialKind = Type.Object({
  ...PLAIN,
  a: Type.Intersect([Type.String(), Type.Unsafe<unknown>({ [Kind]: 'DrzlBenchTrivial' })]),
});

// The same cap DRZL emits, counted without building an array. A code point count is never larger
// than a UTF-16 unit count, so a string whose `.length` already fits the cap fits it in characters
// too, and the spread only has to run for the long ones. Same answer, no allocation on the path
// every ordinary row takes.
const fastCapKind = Type.Object({
  ...PLAIN,
  a: Type.Intersect([
    Type.String(),
    Type.Unsafe<unknown>({
      [Kind]: 'DrzlBenchFast',
      assert: (x: any) => typeof x !== 'string' || x.length <= 64 || [...x].length <= 64,
    }),
  ]),
});

const KINDS: Array<{ name: string; kinds: string; schema: any }> = [
  { name: 'k0, no constraint', kinds: '0', schema: tbK0 },
  { name: 'kw, 2 CHECKs as keywords', kinds: '0', schema: tbKw },
  {
    name: 'Intersect, no kind (hand-built)',
    kinds: '0',
    schema: Type.Intersect([Type.Object(PLAIN), Type.Object({})]),
  },
  { name: 'kind returning true (hand-built)', kinds: '1 column', schema: trivialKind },
  { name: 'cap without spread (hand-built)', kinds: '1 column', schema: fastCapKind },
  { name: 'cap1, 1 varchar(64)', kinds: '1 column', schema: tbCap1 },
  { name: 'cap4, 4 varchar(64)', kinds: '4 column', schema: tbCap4 },
  { name: 'k1, 1 length() CHECK', kinds: '1 row', schema: tbK1 },
  { name: 'k2, 2 length() CHECKs', kinds: '2 row', schema: tbK2 },
  { name: 'k4, 4 length() CHECKs', kinds: '4 row', schema: tbK4 },
];

const kindRows: string[][] = [];
for (const c of KINDS) {
  const compiled = TypeCompiler.Compile(c.schema);
  // Every schema here accepts every good row and rejects every bad one. One that quietly accepted
  // a bad row would make the failure column measure the success path.
  for (const r of ROW_POOL) if (!compiled.Check(r)) throw new Error(`${c.name} rejected a good row`);
  for (const r of BAD_POOL) if (compiled.Check(r)) throw new Error(`${c.name} accepted a bad row`);
  kindRows.push([
    c.name,
    c.kinds,
    compileMicros(c.schema),
    spread((r) => compiled.Check(r), ROW_POOL),
    spread((r) => Value.Check(c.schema, r), ROW_POOL),
    spread((r) => compiled.Check(r), BAD_POOL),
  ]);
}

const NARROWS: Array<{ name: string; narrows: string; schema: any }> = [
  { name: 'k0, no constraint', narrows: '0', schema: akK0 },
  { name: 'cap1, 1 varchar(64)', narrows: '1 column', schema: akCap1 },
  { name: 'k1, 1 length() CHECK', narrows: '1 root', schema: akK1 },
  { name: 'k4, 4 length() CHECKs', narrows: '4 root', schema: akK4 },
];

const narrowRows = NARROWS.map((c) => [
  c.name,
  c.narrows,
  spread((r) => !(c.schema(r) instanceof type.errors), ROW_POOL),
  spread((r) => c.schema.allows(r), ROW_POOL),
  spread((r) => !(c.schema(r) instanceof type.errors), BAD_POOL),
]);

console.log('');
console.log('Each generator against drizzle-orm\'s own, same table, same rows');
console.log('');
table(['generator, operation', 'measure', 'DRZL', 'drizzle-orm'], genRows, true);
console.log('');
console.log('TypeBox: what a registered kind costs, on tables that differ only in that');
console.log('');
table(
  ['schema', 'kinds', 'Compile us', 'compiled ok/s', 'Value.Check ok/s', 'compiled bad/s'],
  kindRows
);
console.log('');
console.log('arktype: the same question for narrow, which is where its CHECKs live');
console.log('');
table(['schema', 'narrows', 'call ok/s', 'allows ok/s', 'call bad/s'], narrowRows);
console.log('');
console.log(
  `median [min..max] of ${REPS} measurements, each a ${Number(WINDOW_NS) / 1e6}ms window`
);
console.log(`node ${process.version}`);
BENCH

echo "==> benchmarking (BENCH_REPS=$REPS, BENCH_WINDOW_MS=$WINDOW_MS)"
BENCH_REPS="$REPS" BENCH_WINDOW_MS="$WINDOW_MS" npx tsx bench.ts
