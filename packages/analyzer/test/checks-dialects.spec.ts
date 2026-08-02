/**
 * CHECK constraints across all three dialects, against real drizzle-orm.
 *
 * Every check test until now built a Postgres table. Extraction matches on shape rather than on
 * class name, which is what makes it plausible that MySQL and SQLite work, and plausible is not
 * tested: each dialect has its own check builder, its own SQL rendering, and its own quoting of a
 * column inside the expression. A dialect quoting differently would produce an expression the
 * shared parser reads as nothing, and the constraint would vanish in silence, because every
 * generator skips what it cannot parse by design.
 */
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { SchemaAnalyzer } from '../src/index';

const dir = path.resolve(__dirname, 'fixtures');

async function analyzeSource(name: string, source: string) {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${name}.mjs`);
  await fs.writeFile(file, source, 'utf8');
  return new SchemaAnalyzer(path.relative(process.cwd(), file)).analyze({});
}

const DIALECTS = {
  postgres: { mod: 'pg-core', table: 'pgTable', int: 'integer' },
  mysql: { mod: 'mysql-core', table: 'mysqlTable', int: 'int' },
  sqlite: { mod: 'sqlite-core', table: 'sqliteTable', int: 'integer' },
};

describe.each(Object.entries(DIALECTS))('%s', (dialect, d) => {
  const source = `
    import { ${d.table}, ${d.int}, check } from 'drizzle-orm/${d.mod}';
    import { sql } from 'drizzle-orm';
    export const t = ${d.table}('t', { age: ${d.int}('age') }, (t) => [
      check('adult', sql\`\${t.age} >= 18\`),
      check('sane', sql\`\${t.age} < 150\`),
    ]);
  `;

  it('finds every check on the table', async () => {
    const a = await analyzeSource(`checks-${dialect}`, source);
    const checks = a.tables.find((x) => x.name === 't')?.checks ?? [];
    expect(checks.map((c) => c.name).sort()).toEqual(['adult', 'sane']);
  });

  it('renders an expression the shared parser understands', async () => {
    // Reproducing the parser here rather than importing it: validation-core depends on this
    // package, so this package cannot depend back on it. The shape asserted is the one the
    // parser requires, `<column> <operator> <literal>` with the column under its TS name.
    const a = await analyzeSource(`checks-${dialect}`, source);
    const checks = a.tables.find((x) => x.name === 't')?.checks ?? [];
    const adult = checks.find((c) => c.name === 'adult');
    expect(adult?.expression?.trim()).toBe('age >= 18');
  });

  it('names the column as the analyzer names it, not as SQL quotes it', async () => {
    const a = await analyzeSource(`checks-${dialect}`, source);
    const checks = a.tables.find((x) => x.name === 't')?.checks ?? [];
    expect(checks.length).toBeGreaterThan(0);
    for (const c of checks) {
      // MySQL quotes with backticks and the others with double quotes. Either reaching the
      // output would make the column name unrecognisable to the generators.
      expect(c.expression, `${c.expression} carries a quote`).not.toMatch(/["`]/);
    }
  });
});

describe.each(Object.entries(DIALECTS))('%s, when the TS name differs from the column name', (dialect, d) => {
  // The generators emit TS names, because that is what a generated schema's keys have to spell.
  // A check rendering the database name instead would name a key that does not exist in the
  // emitted object, and every generator would drop the constraint without saying so.
  const source = `
    import { ${d.table}, ${d.int}, check } from 'drizzle-orm/${d.mod}';
    import { sql } from 'drizzle-orm';
    export const t = ${d.table}('t', { userAge: ${d.int}('user_age') }, (t) => [
      check('adult', sql\`\${t.userAge} >= 18\`),
    ]);
  `;

  it('renders the TS name, which is what the emitted schema keys on', async () => {
    const a = await analyzeSource(`checks-renamed-${dialect}`, source);
    const checks = a.tables.find((x) => x.name === 't')?.checks ?? [];
    expect(checks[0]?.expression?.trim()).toBe('userAge >= 18');
  });
});
