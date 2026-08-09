/**
 * `drzl explain` against a real schema, spawned as a real process.
 *
 * The unit spec next door works over hand-built analyses, which is the right shape for the
 * matching rules and the "nothing states this" verdicts. This one is here for the half that a
 * hand-built analysis cannot prove: that the *analyzer* answers these questions the way the report
 * claims. An unsigned MySQL `int` really coming back as `0 to 4294967295`, a `bigint({ mode:
 * 'number' })` really carrying a different range from a `bigint({ mode: 'bigint' })`, and a regex
 * CHECK really being the one the shared parser declines are each a fact about a package this file
 * does not import, and each of them has been the subject of a defect in this repository.
 *
 * It also pins the process-level contract: which stream carries the report, the three exit codes,
 * and the shape of the `--json` document.
 *
 * Requires a build. CI builds before testing; locally, run `pnpm build` first.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';

const CLI = path.resolve(__dirname, '..', 'dist', 'cli.js');
const ROOT = path.join(__dirname, '.tmp-explain');

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run the built CLI and keep both streams apart.
 *
 * Colour is forced off rather than left to the pipe's own answer, because a `FORCE_COLOR` exported
 * by the developer's shell would otherwise put escapes through every assertion on the text. The
 * separate colour spec is where the per-stream rules are tested; here they are noise.
 */
function run(args: string[], cwd = ROOT): Promise<Run> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      { cwd, env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' }, maxBuffer: 20 * 1024 * 1024 },
      (error: any, stdout, stderr) => {
        if (error && typeof error.code !== 'number') return reject(error);
        resolve({ code: error ? error.code : 0, stdout, stderr });
      }
    );
  });
}

/**
 * One schema carrying every case worth a line in this report.
 *
 * A composite key, a natural key, a declared enum, a nullable column with a literal default, both
 * bigint modes, a foreign key with a relation over it, and four CHECK constraints: a bound the
 * parser folds into a range, a count it translates, a cardinality on an array, and a regex it
 * declines whole. The declined one is the case the whole command exists for.
 */
const PG_SCHEMA = `
import { relations, sql } from 'drizzle-orm';
import {
  bigint, boolean, check, doublePrecision, integer, jsonb, numeric, pgEnum, pgTable,
  primaryKey, serial, text, timestamp, unique, uuid, varchar,
} from 'drizzle-orm/pg-core';

export const role = pgEnum('role', ['admin', 'member', 'guest']);

export const users = pgTable(
  'users',
  {
    id: serial('id').primaryKey(),
    email: varchar('email', { length: 255 }).notNull().unique(),
    nickname: text('nickname').default('anon'),
    role: role('role').notNull().default('member'),
    age: integer('age'),
    balance: numeric('balance', { precision: 10, scale: 2 }).notNull(),
    score: doublePrecision('score'),
    followers: bigint('followers', { mode: 'bigint' }).notNull(),
    visits: bigint('visits', { mode: 'number' }).notNull(),
    ref: uuid('ref').notNull(),
    tags: text('tags').array(),
    payload: jsonb('payload'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('age_adult', sql\`\${t.age} >= 18\`),
    check('nickname_len', sql\`length(\${t.nickname}) > 2\`),
    check('email_shape', sql\`\${t.email} ~ '^[^@]+@[^@]+$'\`),
    check('tags_present', sql\`cardinality(\${t.tags}) > 0\`),
  ]
);

export const memberships = pgTable(
  'memberships',
  {
    orgId: integer('org_id').notNull(),
    userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    joinedAt: timestamp('joined_at').notNull(),
    active: boolean('active').notNull().default(true),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.userId] }),
    unique('membership_alt').on(t.userId, t.joinedAt),
  ]
);

export const countries = pgTable('countries', {
  code: text('code').primaryKey(),
  name: text('name').notNull(),
});

export const usersRelations = relations(users, ({ many }) => ({
  memberships: many(memberships),
}));
export const membershipsRelations = relations(memberships, ({ one }) => ({
  user: one(users, { fields: [memberships.userId], references: [users.id] }),
}));
`;

/**
 * The MySQL half, because unsigned exists nowhere else and a schema has one dialect.
 *
 * `label` is the case where a declared width is real and no emitted schema writes it: the CHECK
 * narrows the column to two literals, and a set states the value space instead of a cap.
 */
const MYSQL_SCHEMA = `
import { sql } from 'drizzle-orm';
import { bigint, check, int, mysqlTable, text, tinyint, varchar } from 'drizzle-orm/mysql-core';

export const counters = mysqlTable(
  'counters',
  {
    id: int('id', { unsigned: true }).primaryKey().autoincrement(),
    hits: bigint('hits', { mode: 'bigint', unsigned: true }).notNull(),
    small: tinyint('small', { unsigned: true }).notNull(),
    label: varchar('label', { length: 32 }).notNull(),
    body: text('body'),
  },
  (t) => [
    check('label_set', sql\`\${t.label} IN ('a', 'b')\`),
    check('odd', sql\`\${t.small} % 2 = 1\`),
  ]
);
`;

/** Two tables that share one database name, which is what makes a bare name ambiguous. */
const TWO_SCHEMAS = `
import { integer, pgSchema, pgTable, text } from 'drizzle-orm/pg-core';
const reporting = pgSchema('reporting');
export const users = pgTable('users', { id: integer('id').primaryKey() });
export const reportingUsers = reporting.table('users', {
  id: integer('id').primaryKey(),
  note: text('note'),
});
`;

beforeAll(async () => {
  if (!existsSync(CLI)) {
    throw new Error(`Built CLI not found at ${CLI}. Run \`pnpm build\` before \`pnpm test\`.`);
  }
  await fs.rm(ROOT, { recursive: true, force: true });
  await fs.mkdir(path.join(ROOT, 'src', 'db'), { recursive: true });
  await fs.writeFile(path.join(ROOT, 'src', 'db', 'schema.ts'), PG_SCHEMA, 'utf8');
  await fs.writeFile(path.join(ROOT, 'src', 'db', 'mysql.ts'), MYSQL_SCHEMA, 'utf8');
  await fs.writeFile(path.join(ROOT, 'src', 'db', 'two-schemas.ts'), TWO_SCHEMAS, 'utf8');
  await fs.writeFile(path.join(ROOT, 'src', 'db', 'empty.ts'), 'export const x = 1;\n', 'utf8');
}, 60_000);

afterAll(async () => {
  await fs.rm(ROOT, { recursive: true, force: true });
});

const pg = (...args: string[]) => run(['explain', ...args, '-s', 'src/db/schema.ts']);

describe('drzl explain <table>', () => {
  it('puts the report on stdout and nothing on stderr, and exits 0', async () => {
    const r = await pg('users');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Columns');
    expect(r.stderr).toBe('');
  }, 60_000);

  it('names the table, the export and the dialect in the header', async () => {
    const { stdout } = await pg('users');
    expect(stdout).toContain('postgres, table "users", export "users", 13 columns');
  }, 60_000);

  it('shows the declared SQL type per column, which is the wire the fixes turned on', async () => {
    const { stdout } = await pg('users');
    expect(stdout).toContain('varchar(255)');
    expect(stdout).toContain('numeric(10, 2)');
    expect(stdout).toContain('timestamp with time zone');
    expect(stdout).toContain('text[]');
  }, 60_000);

  it('states the two bigint modes apart, by the range each really carries', async () => {
    const { stdout } = await pg('users');
    // `{ mode: 'bigint' }` is the full signed 64 bit range; `{ mode: 'number' }` stops at the
    // safe-integer ceiling, because past it a JS number is not the value the driver returned.
    expect(stdout).toContain('-9223372036854775808 to 9223372036854775807');
    expect(stdout).toContain('-9007199254740991 to 9007199254740991');
  }, 60_000);

  it('lists the enum members', async () => {
    expect((await pg('users')).stdout).toContain("one of 'admin', 'member', 'guest'");
  }, 60_000);

  it('states NaN and Infinity, which a range cannot say', async () => {
    const { stdout } = await pg('users');
    expect(stdout).toContain('NaN is stored and returned');
    expect(stdout).toContain('Infinity is stored and returned');
  }, 60_000);

  it('reports a nullable column with a literal default as both', async () => {
    const { stdout } = await pg('users');
    expect(stdout).toMatch(/nickname\s+string\s+text\s+yes\s+default 'anon'/);
  }, 60_000);

  it('reports the three CHECK forms it translates as enforced', async () => {
    const { stdout } = await pg('users');
    for (const rule of [
      'CHECK (age >= 18)',
      'CHECK (length(nickname) > 2)',
      'CHECK (cardinality(tags) > 0)',
    ]) {
      expect(stdout).toContain(rule);
    }
    expect(stdout.match(/^\s+enforced$/gm)?.length).toBe(3);
  }, 60_000);

  // The reason the command exists. The constraint is in the schema, the database enforces it, the
  // generated validator does not, and nothing in the generated files says so.
  it('names the CHECK the parser declines, with the reason, under Not understood', async () => {
    const { stdout } = await pg('users');
    expect(stdout).toContain('not enforced by any generated schema');
    expect(stdout).toContain('not a single comparison this version understands');
    expect(stdout).toContain('Not understood  (1)');
  }, 60_000);

  it('reports a composite key whole', async () => {
    const { stdout } = await pg('memberships');
    expect(stdout).toContain('PRIMARY KEY (orgId, userId)');
    expect(stdout).toContain('UNIQUE (userId, joinedAt)');
  }, 60_000);

  it('reports the foreign key and the relations over it', async () => {
    const { stdout } = await pg('memberships');
    expect(stdout).toContain('(userId) -> users (id)');
    expect(stdout).toContain('ON DELETE cascade');
    expect(stdout).toContain('memberships -> users');
  }, 60_000);

  it('reports a natural key as the key it is', async () => {
    const { stdout } = await pg('countries');
    expect(stdout).toContain('PRIMARY KEY (code)');
    expect(stdout).toContain('Nothing about this table was dropped or left unrecognised.');
  }, 60_000);

  it('fits a terminal 80 columns wide on every line', async () => {
    for (const table of ['users', 'memberships', 'countries']) {
      const { stdout } = await pg(table);
      const wide = stdout.split('\n').filter((line) => line.length > 80);
      expect(wide, `${table} has lines past 80 columns`).toEqual([]);
    }
  }, 120_000);
});

describe('the MySQL half', () => {
  const mysql = (...args: string[]) => run(['explain', ...args, '-s', 'src/db/mysql.ts']);

  it('gives an unsigned column the range it actually holds', async () => {
    const { stdout } = await mysql('counters');
    expect(stdout).toContain('int unsigned');
    expect(stdout).toContain('0 to 4294967295');
    expect(stdout).toContain('0 to 255');
    expect(stdout).toContain('0 to 18446744073709551615');
    // The signed answer this family used to give, which refused every value in the top half.
    expect(stdout).not.toContain('-2147483648');
  }, 60_000);

  it('says a declared width is not stated when a CHECK narrows the column to a set', async () => {
    const { stdout } = await mysql('counters');
    expect(stdout).toContain('at most 32 characters');
    expect(stdout.replace(/\s+/g, ' ')).toContain('a CHECK narrows "label" to a set of literals');
  }, 60_000);

  it('reports the byte budget a MySQL text column carries in its own type', async () => {
    expect((await mysql('counters')).stdout).toContain('at most 65535 bytes');
  }, 60_000);
});

describe('finding the table by name', () => {
  it('matches the schema-qualified name', async () => {
    const r = await run(['explain', 'reporting.users', '-s', 'src/db/two-schemas.ts']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('export "reportingUsers"');
  }, 60_000);

  it('matches the TypeScript export name', async () => {
    const r = await run(['explain', 'reportingUsers', '-s', 'src/db/two-schemas.ts']);
    expect(r.stdout).toContain('reporting.users');
  }, 60_000);

  it('refuses a bare name that reaches two schemas, and says how to separate them', async () => {
    const r = await run(['explain', 'users', '-s', 'src/db/two-schemas.ts']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('DRZL_EXPLAIN_002');
    expect(r.stderr).toContain('reporting.users');
    expect(r.stdout).toBe('');
  }, 60_000);

  it('names the tables there are, and suggests the near miss', async () => {
    const r = await pg('userz');
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('DRZL_EXPLAIN_001');
    expect(r.stderr).toContain('countries, memberships, users');
    expect(r.stderr).toContain('Did you mean "users"?');
  }, 60_000);
});

describe('a schema it cannot use', () => {
  it('reports a missing file through the shared schema code, not a new message', async () => {
    const r = await run(['explain', 'users', '-s', 'src/db/nope.ts']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Schema file not found (DRZL_SCHEMA_001)');
    // The one thing that had to change: this command has never written a file.
    expect(r.stderr).toContain('There is nothing to explain.');
    expect(r.stderr).not.toContain('Nothing was generated.');
  }, 60_000);

  it('tells a module that declares no tables apart from one that would not import', async () => {
    const r = await run(['explain', 'users', '-s', 'src/db/empty.ts']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('DRZL_SCHEMA_002');
  }, 60_000);

  it('says there is no schema at all rather than failing to parse one', async () => {
    const bare = path.join(ROOT, 'bare');
    await fs.mkdir(bare, { recursive: true });
    const r = await run(['explain', 'users'], bare);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('DRZL_CFG_001');
    expect(r.stderr).toContain('--schema');
  }, 60_000);
});

describe('the index a bare drzl explain prints', () => {
  it('lists every table with the count of what was not understood', async () => {
    const r = await run(['explain', '-s', 'src/db/schema.ts']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('3 tables');
    expect(r.stdout).toContain('1 thing not understood');
    expect(r.stdout).toContain('drzl explain <table>');
  }, 60_000);
});

describe('--json', () => {
  it('writes exactly one document to stdout and nothing to stderr', async () => {
    const r = await pg('users', '--json');
    expect(r.stderr).toBe('');
    const doc = JSON.parse(r.stdout);
    expect(doc.command).toBe('explain');
    expect(doc.exitCode).toBe(0);
    expect(doc.dialect).toBe('postgres');
    expect(doc.schema).toBe('src/db/schema.ts');
  }, 60_000);

  it('pins the document shape', async () => {
    const { stdout } = await pg('users', '--json');
    const doc = JSON.parse(stdout);
    expect(Object.keys(doc)).toEqual(['command', 'exitCode', 'schema', 'dialect', 'table']);
    expect(Object.keys(doc.table)).toEqual([
      'name',
      'tsName',
      'qualified',
      'addressable',
      'readOnly',
      'matchedOn',
      'matchedExactly',
      'columns',
      'primaryKey',
      'unique',
      'indexes',
      'foreignKeys',
      'relations',
      'constraints',
      'gaps',
    ]);
    const email = doc.table.columns.find((c: any) => c.name === 'email');
    expect(email).toMatchObject({
      name: 'email',
      tsType: 'string',
      dbType: 'TEXT',
      sqlType: 'varchar(255)',
      nullable: false,
      hasDefault: false,
      default: null,
      isGenerated: false,
      inPrimaryKey: false,
      unique: true,
    });
    expect(email.facts).toContainEqual({ text: 'at most 255 characters', stated: true });
    expect(doc.table.primaryKey).toEqual({ columns: ['id'], generated: true });
    expect(doc.table.gaps).toEqual([
      {
        kind: 'check',
        subject: 'email_shape',
        message:
          "email_shape: email ~ '^[^@]+@[^@]+$' is not enforced: not a single comparison this " +
          'version understands.',
        hint: 'Your database still enforces it. Nothing DRZL generates does.',
      },
    ]);
  }, 60_000);

  it('carries the enforcement verdict per constraint', async () => {
    const { stdout } = await pg('users', '--json');
    const byId = Object.fromEntries(
      JSON.parse(stdout).table.constraints.map((c: any) => [c.id, c])
    );
    expect(byId.users_pkey.enforced).toBe(false);
    expect(byId.age_adult.enforced).toBe(true);
    expect(byId.email_shape.enforced).toBe(false);
    expect(byId.email_shape.unenforced[0].reason).toContain('not a single comparison');
  }, 60_000);

  it('writes a failure document, with the same code the human run prints', async () => {
    const r = await pg('userz', '--json');
    expect(r.code).toBe(1);
    expect(r.stderr).toBe('');
    expect(JSON.parse(r.stdout)).toMatchObject({
      ok: false,
      command: 'explain',
      code: 'DRZL_EXPLAIN_001',
      exitCode: 1,
    });
  }, 60_000);

  it('emits the index under --json when no table is named', async () => {
    const { stdout } = await run(['explain', '-s', 'src/db/schema.ts', '--json']);
    const doc = JSON.parse(stdout);
    expect(Object.keys(doc)).toEqual(['command', 'exitCode', 'schema', 'dialect', 'tables']);
    expect(doc.tables.map((t: any) => t.name).sort()).toEqual([
      'countries',
      'memberships',
      'users',
    ]);
  }, 60_000);
});

describe('--quiet', () => {
  it('keeps the report, because that is the answer rather than the narration', async () => {
    const r = await pg('users', '--quiet');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Columns');
    expect(r.stderr).toBe('');
  }, 60_000);

  it('keeps the failure, and drops only the hint under it', async () => {
    const r = await pg('userz', '--quiet');
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('DRZL_EXPLAIN_001');
    expect(r.stderr).not.toContain('Did you mean');
  }, 60_000);
});

describe('the config', () => {
  it('reads the schema path from drzl.config when none is given', async () => {
    const dir = path.join(ROOT, 'configured');
    await fs.mkdir(path.join(dir, 'src', 'db'), { recursive: true });
    await fs.writeFile(path.join(dir, 'src', 'db', 'schema.ts'), PG_SCHEMA, 'utf8');
    await fs.writeFile(
      path.join(dir, 'drzl.config.ts'),
      "export default { schema: 'src/db/schema.ts', outDir: 'out', exclude: ['countries'], " +
        "columns: { users: { omit: ['payload'] } }, generators: [{ kind: 'zod' }] };\n",
      'utf8'
    );
    const r = await run(['explain', 'users'], dir);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('export "users"');
    // The filter narrows what the generators see, and saying so is the answer to "why is this
    // column not in my validator".
    expect(r.stdout).toContain('removes 1 of these columns: payload');
  }, 60_000);

  // A table the config excludes is exactly the one whose absence needs explaining, so it is still
  // found. Reporting "there is no such table" would be the wrong answer to the right question.
  it('still explains a table this config excludes, and says the config excludes it', async () => {
    const dir = path.join(ROOT, 'configured');
    const r = await run(['explain', 'countries'], dir);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('include/exclude removes this table');
  }, 60_000);
});
