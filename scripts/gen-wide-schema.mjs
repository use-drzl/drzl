#!/usr/bin/env node
//
// Emit a Drizzle schema of a stated size, so a benchmark on "a 200-table schema" says exactly
// which 200 tables.
//
// Every fixture in the repository is tens of columns, which is the size a correctness test wants
// and the size a timing claim cannot be made at. Hand-writing 200 tables would produce a fixture
// nobody can check and nobody can vary, so this script is the fixture: the arguments are the
// honest description of it, and the same arguments always emit the same bytes.
//
// Usage:
//   node scripts/gen-wide-schema.mjs --tables 200 --columns 12 --checks 4 > schema.ts
//
// Options, all with defaults chosen to look like a real application schema rather than a
// worst case:
//   --tables N    tables to emit (default 200)
//   --columns C   non-key columns per table, cycled through the type list below (default 12)
//   --checks K    CHECK constraints per table, 0..4, one of each parsed form (default 4)
//   --enums E     pgEnum declarations, shared across tables round-robin (default 8)
//   --dialect D   pg | mysql | sqlite (default pg)
//   --relations   also emit a defineRelations block
//
// The four CHECK forms are the four the constraint parser recognises, one each, so a table
// exercises every branch rather than the same branch four times.
const ARGS = process.argv.slice(2);

/** Read `--name value`, falling back to `def`. Numbers only; this script takes no strings. */
function num(name, def) {
  const i = ARGS.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = Number(ARGS[i + 1]);
  if (!Number.isFinite(v)) throw new Error(`--${name} needs a number, got ${ARGS[i + 1]}`);
  return v;
}

/** Read `--name value` as a string from a fixed set. */
function pick(name, def, allowed) {
  const i = ARGS.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = ARGS[i + 1];
  if (!allowed.includes(v)) throw new Error(`--${name} must be one of ${allowed.join(', ')}`);
  return v;
}

const TABLES = num('tables', 200);
const COLUMNS = num('columns', 12);
const CHECKS = Math.max(0, Math.min(4, num('checks', 4)));
const ENUMS = num('enums', 8);
const DIALECT = pick('dialect', 'pg', ['pg', 'mysql', 'sqlite']);
const RELATIONS = ARGS.includes('--relations');

/**
 * The column types one table cycles through, in the proportion an application schema tends to
 * have them: mostly text and numbers, a few timestamps, one of each awkward type.
 *
 * The awkward ones are here on purpose. `numeric` carries precision and scale, `varchar` carries
 * a length the generators turn into a predicate rather than a keyword, `jsonb` is the type whose
 * inference the analyzer cannot do from the column alone, and the array wraps an element type
 * that has its own cap. A fixture of nothing but `text` would measure a path no schema takes.
 */
const PG_COLUMNS = [
  { name: 'title', decl: 'varchar({ length: 200 }).notNull()' },
  { name: 'body', decl: 'text()' },
  { name: 'count', decl: 'integer().notNull()' },
  { name: 'ratio', decl: 'doublePrecision()' },
  { name: 'active', decl: 'boolean().notNull().default(true)' },
  { name: 'createdAt', decl: "timestamp({ mode: 'string' }).notNull()" },
  { name: 'slug', decl: 'varchar({ length: 64 }).notNull()' },
  { name: 'amount', decl: 'numeric({ precision: 12, scale: 2 })' },
  { name: 'payload', decl: 'jsonb()' },
  { name: 'tags', decl: 'varchar({ length: 32 }).array()' },
  { name: 'big', decl: "bigint({ mode: 'bigint' })" },
  { name: 'updatedAt', decl: "timestamp({ mode: 'date' })" },
  { name: 'note', decl: 'text()' },
  { name: 'weight', decl: 'real()' },
  { name: 'small', decl: 'smallint()' },
  { name: 'uid', decl: 'uuid()' },
];

const MYSQL_COLUMNS = [
  { name: 'title', decl: 'varchar({ length: 200 }).notNull()' },
  { name: 'body', decl: 'text()' },
  { name: 'count', decl: 'int().notNull()' },
  { name: 'ratio', decl: 'double()' },
  { name: 'active', decl: 'boolean().notNull().default(true)' },
  { name: 'createdAt', decl: "timestamp({ mode: 'string' }).notNull()" },
  { name: 'slug', decl: 'varchar({ length: 64 }).notNull()' },
  { name: 'amount', decl: 'decimal({ precision: 12, scale: 2 })' },
  { name: 'payload', decl: 'json()' },
  { name: 'tiny', decl: 'tinytext()' },
  { name: 'big', decl: "bigint({ mode: 'bigint' })" },
  { name: 'updatedAt', decl: "datetime({ mode: 'date' })" },
];

const SQLITE_COLUMNS = [
  { name: 'title', decl: 'text().notNull()' },
  { name: 'body', decl: 'text()' },
  { name: 'count', decl: 'integer().notNull()' },
  { name: 'ratio', decl: 'real()' },
  { name: 'active', decl: "integer({ mode: 'boolean' }).notNull().default(true)" },
  { name: 'createdAt', decl: "integer({ mode: 'timestamp' }).notNull()" },
  { name: 'slug', decl: 'text().notNull()' },
  { name: 'amount', decl: 'real()' },
  { name: 'payload', decl: "text({ mode: 'json' })" },
  { name: 'blobby', decl: 'blob()' },
  { name: 'big', decl: "blob({ mode: 'bigint' })" },
  { name: 'updatedAt', decl: "integer({ mode: 'timestamp' })" },
];

const BY_DIALECT = {
  pg: {
    columns: PG_COLUMNS,
    table: 'pgTable',
    module: 'drizzle-orm/pg-core',
    imports: [
      'pgTable',
      'pgEnum',
      'text',
      'integer',
      'smallint',
      'bigint',
      'varchar',
      'boolean',
      'timestamp',
      'numeric',
      'doublePrecision',
      'real',
      'jsonb',
      'uuid',
      'check',
      'index',
      'uniqueIndex',
    ],
    serial: 'integer().primaryKey().notNull()',
  },
  mysql: {
    columns: MYSQL_COLUMNS,
    table: 'mysqlTable',
    module: 'drizzle-orm/mysql-core',
    imports: [
      'mysqlTable',
      'mysqlEnum',
      'text',
      'tinytext',
      'int',
      'bigint',
      'varchar',
      'boolean',
      'timestamp',
      'datetime',
      'decimal',
      'double',
      'json',
      'check',
      'index',
      'uniqueIndex',
    ],
    serial: 'int().primaryKey().notNull()',
  },
  sqlite: {
    columns: SQLITE_COLUMNS,
    table: 'sqliteTable',
    module: 'drizzle-orm/sqlite-core',
    imports: ['sqliteTable', 'text', 'integer', 'real', 'blob', 'check', 'index', 'uniqueIndex'],
    serial: 'integer().primaryKey().notNull()',
  },
};

const D = BY_DIALECT[DIALECT];

/** Table `n`'s exported name. Zero padded so the export order matches the numeric order. */
const tbl = (n) => `t${String(n).padStart(3, '0')}`;

const lines = [];
lines.push(`// Generated by scripts/gen-wide-schema.mjs`);
lines.push(
  `// --tables ${TABLES} --columns ${COLUMNS} --checks ${CHECKS} --enums ${ENUMS} --dialect ${DIALECT}${RELATIONS ? ' --relations' : ''}`
);
lines.push(`import { ${D.imports.join(', ')} } from '${D.module}';`);
lines.push(`import { sql } from 'drizzle-orm';`);
if (RELATIONS) lines.push(`import { defineRelations } from 'drizzle-orm';`);
lines.push('');

// Enums, declared once and shared, which is what a real schema does with a status column.
const enumNames = [];
if (DIALECT === 'pg') {
  for (let e = 0; e < ENUMS; e++) {
    const name = `status${e}`;
    enumNames.push(name);
    lines.push(
      `export const ${name} = pgEnum('${name}', ['draft', 'active', 'archived', 'deleted']);`
    );
  }
  if (ENUMS) lines.push('');
}

for (let i = 0; i < TABLES; i++) {
  const name = tbl(i);
  const cols = [`  id: ${D.serial},`];
  /** Which column names this table actually declared, so nothing below can name one it did not. */
  const present = new Set(['id']);
  for (let c = 0; c < COLUMNS; c++) {
    const src = D.columns[c % D.columns.length];
    // A cycled column keeps its own name on the first pass and takes a suffix afterwards, so a
    // table of 30 columns has 30 distinct names and no silent overwrite in the object literal.
    const colName =
      c < D.columns.length ? src.name : `${src.name}${Math.floor(c / D.columns.length)}`;
    cols.push(`  ${colName}: ${src.decl},`);
    present.add(colName);
  }
  if (DIALECT === 'pg' && ENUMS) {
    cols.push(`  status: ${enumNames[i % ENUMS]}().notNull(),`);
  }
  if (DIALECT === 'mysql') {
    cols.push(`  status: mysqlEnum(['draft', 'active', 'archived', 'deleted']).notNull(),`);
  }
  // A foreign key to the table before it, so the analyzer has a graph to walk rather than 200
  // islands. The first table points at nothing, which is what makes the graph a tree.
  if (i > 0) {
    const fkBase = D.serial.replace('.primaryKey()', '').replace('.notNull()', '');
    cols.push(`  parentId: ${fkBase}.references(() => ${tbl(i - 1)}.id),`);
  }

  const extras = [];
  // One of each CHECK form the constraint parser recognises: a comparison, a range, a set, and a
  // call. Four copies of one form would measure one branch four times.
  //
  // Each is dropped when the column it names is not in this table, which happens at small
  // `--columns`. A constraint on a column the table does not declare renders as
  // `sql`${undefined} >= 0``, which analyzes as a constraint over no column at all: the fixture
  // would still generate, and every measurement of CHECK cost taken on it would be of nothing.
  const forms = [
    ['count', `check('${name}_count_c', sql\`\${t.count} >= 0\`)`],
    ['ratio', `check('${name}_ratio_c', sql\`\${t.ratio} BETWEEN 0 AND 1\`)`],
    ['slug', `check('${name}_slug_c', sql\`\${t.slug} IN ('a', 'b', 'c')\`)`],
    ['title', `check('${name}_title_c', sql\`length(\${t.title}) >= 2\`)`],
  ];
  for (let k = 0; k < CHECKS; k++) {
    if (present.has(forms[k][0])) extras.push(forms[k][1]);
  }
  if (present.has('slug')) extras.push(`uniqueIndex('${name}_slug_u').on(t.slug)`);
  if (present.has('createdAt')) extras.push(`index('${name}_created_i').on(t.createdAt)`);

  lines.push(`export const ${name} = ${D.table}(`);
  lines.push(`  '${name}',`);
  lines.push(`  {`);
  for (const c of cols) lines.push(`  ${c}`);
  lines.push(`  },`);
  lines.push(`  (t) => [`);
  for (const e of extras) lines.push(`    ${e},`);
  lines.push(`  ]`);
  lines.push(`);`);
  lines.push('');
}

if (RELATIONS) {
  lines.push(`export const relations = defineRelations(`);
  lines.push(`  { ${Array.from({ length: TABLES }, (_, i) => tbl(i)).join(', ')} },`);
  lines.push(`  (r) => ({`);
  for (let i = 1; i < TABLES; i++) {
    lines.push(`    ${tbl(i)}: {`);
    lines.push(
      `      parent: r.one.${tbl(i - 1)}({ from: r.${tbl(i)}.parentId, to: r.${tbl(i - 1)}.id }),`
    );
    lines.push(`    },`);
  }
  lines.push(`  })`);
  lines.push(`);`);
  lines.push('');
}

process.stdout.write(lines.join('\n'));
