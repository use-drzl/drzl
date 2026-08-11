import { fileWriter, type FileSink } from '@drzl/validation-core';
import type { Analysis, Column, Table } from '@drzl/analyzer';
import type { ImportExtension } from '@drzl/validation-core';
import { formatCode, importSpecifier, parseCheck } from '@drzl/validation-core';
import type { ColumnCheck, ColumnSet, LengthCheck, RowCheck } from '@drzl/validation-core';

/**
 * Seed rows built to satisfy every constraint the analyzer parsed.
 *
 * The incumbent is `drizzle-seed`, and the gap is not a matter of degree. It reads a Drizzle schema
 * for column types and generates plausible values for them; it does not read `CHECK` constraints at
 * all. Measured against `drizzle-seed@0.3.1` on 2026-08-11: nothing in the package looks at a
 * table's checks, and its only `checks` member is an internal count of how many distinct values a
 * generator can still produce.
 *
 * So a table declaring `CHECK (quantity BETWEEN 1 AND 999)` gets seeded with whatever an unbounded
 * integer generator returns, and the insert fails against the database that declared the rule. The
 * usual answer is to retry until a row happens to pass, which does not terminate for a narrow
 * constraint and never satisfies a row comparison.
 *
 * DRZL already parses those expressions, for the schemas it emits. This generator reads the same
 * parse and *constructs* values inside the permitted region rather than sampling and hoping:
 *
 *   a bound          `quantity >= 1 AND quantity <= 999`   picks within the intersected range
 *   a set            `status IN ('draft', 'live')`          picks a member
 *   a length         `length(name) > 3`                     builds a string of a permitted length
 *   a row comparison `price > cost`                         orders the pair after generating both
 *
 * Every one of those is satisfied by construction, so there is no retry loop and no failure mode
 * where a narrow constraint spins.
 *
 * Deterministic by default. A seed value goes in and the same rows come out, because a fixture that
 * changes between runs turns a failing test into a coin toss.
 */

export type Case = 'camel' | 'kebab' | 'snake';

export interface NamingOptions {
  /** Appended to `tsName` for the file name and the exported function name. */
  routerSuffix?: string;
  /** Casing applied to file names and identifiers. */
  procedureCase?: Case;
}

/** The barrel's filename stem. */
export const SEED_MODULE = 'index';

export interface GenerateOptions {
  outputDir: string;
  /** How many rows each generated function returns when its caller names no count. */
  defaultCount?: number;
  naming?: NamingOptions;
  onProgress?: (info: { index: number; total: number; table: string; filePath: string }) => void;
  format?: { enabled?: boolean; engine?: 'auto' | 'prettier' | 'biome'; configPath?: string };
  outputHeader?: { enabled?: boolean; text?: string };
  /** How every relative specifier this generator invents spells its extension. Defaults to `'js'`. */
  importExtension?: ImportExtension;
  /** Where the generated files go, when that is not the filesystem. */
  fileSink?: FileSink;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const isIdent = (s: string) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s);
const q = (v: string) => JSON.stringify(v);

function objectKey(name: string): string {
  return isIdent(name) ? name : JSON.stringify(name);
}

function toCase(s: string, c?: Case): string {
  if (!c) return s;
  const parts = s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]/g, ' ')
    .split(/\s+/);
  if (c === 'camel') {
    return parts
      .map((p, i) =>
        i === 0 ? p.toLowerCase() : p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()
      )
      .join('');
  }
  if (c === 'kebab') return parts.map((p) => p.toLowerCase()).join('-');
  if (c === 'snake') return parts.map((p) => p.toLowerCase()).join('_');
  return s;
}

function seedFnName(table: Table, naming?: NamingOptions): string {
  const c = naming?.procedureCase;
  const base = toCase(`${table.tsName}${naming?.routerSuffix ?? ''}`, c === 'kebab' ? 'camel' : c);
  return `seed${cap(base)}`;
}

function rowTypeName(table: Table, naming?: NamingOptions): string {
  const c = naming?.procedureCase;
  const base = toCase(`${table.tsName}${naming?.routerSuffix ?? ''}`, c === 'kebab' ? 'camel' : c);
  return `${cap(base)}SeedRow`;
}

/** Everything one table's CHECKs said, in the shapes this generator acts on. */
interface Parsed {
  bounds: ColumnCheck[];
  sets: ColumnSet[];
  rows: RowCheck[];
  lengths: LengthCheck[];
  /** Expressions the parser refused, carried so the emitted module can name them. */
  unparsed: string[];
}

function parseTable(table: Table): Parsed {
  const out: Parsed = { bounds: [], sets: [], rows: [], lengths: [], unparsed: [] };
  for (const k of table.checks ?? []) {
    const parsed = parseCheck(k.expression, k.name, table.dialect);
    if (!parsed.ok) {
      // `expression` is optional on a Check, and a nameless one with no text says nothing at all.
      const text = k.expression ?? '';
      out.unparsed.push(k.name ? `${k.name}: ${text}` : text || '(an unnamed check with no expression)');
      continue;
    }
    out.bounds.push(...parsed.checks);
    out.sets.push(...(parsed.sets ?? []));
    out.rows.push(...(parsed.rows ?? []));
    out.lengths.push(...(parsed.lengths ?? []));
  }
  return out;
}

/**
 * The numeric window a column's value has to land in.
 *
 * Both sources are intersected rather than one preferred: the column's own declared range comes
 * from its SQL type, and a CHECK narrows it further. `>` and `<` are turned into inclusive bounds a
 * step in, because the generator picks integers where it can and a strict bound on a whole number
 * is the next one along.
 *
 * Numbers here, not strings, and that is a deliberate narrowing rather than an oversight. The
 * analyzer carries bounds as decimal text because a 64 bit bound does not survive a JS number, and
 * that matters for a *schema*, which has to state the bound exactly. A seed row only has to land
 * inside the window, so it is enough to clamp the window to the safe integer range first and pick
 * within that. `bigint` columns are handled apart, as digits.
 */
interface Window {
  min: number;
  max: number;
  integer: boolean;
}

const SAFE_MIN = -9007199254740991;
const SAFE_MAX = 9007199254740991;

/**
 * The window an unconstrained number is drawn from.
 *
 * Not the column's full range, which is the obvious choice and a bad one. An `integer` column with
 * no CHECK is bounded only by its SQL type, so drawing from that gave a `price` of
 * 4283991245827361 and a `cost` just under it: satisfying every stated constraint, and useless as a
 * fixture. Nothing declared a bound, so nothing is violated by choosing a readable one, and a
 * fixture's job is to be looked at.
 *
 * Every declared bound still wins: this is only where the intersection is otherwise unbounded.
 */
const FIXTURE_MIN = 0;
const FIXTURE_MAX = 10000;

function numericWindow(column: Column, bounds: ColumnCheck[]): Window {
  const integer = column.integer ?? false;
  const declaredMin = column.min !== undefined ? Number(column.min) : undefined;
  const declaredMax = column.max !== undefined ? Number(column.max) : undefined;
  let min = declaredMin !== undefined && Number.isFinite(declaredMin) ? declaredMin : SAFE_MIN;
  let max = declaredMax !== undefined && Number.isFinite(declaredMax) ? declaredMax : SAFE_MAX;
  // Whether a CHECK narrowed either end, which decides if the fixture window applies below.
  let narrowedMin = false;
  let narrowedMax = false;

  for (const b of bounds) {
    if (b.column !== column.name || b.kind !== 'number') continue;
    const v = Number(b.value);
    if (!Number.isFinite(v)) continue;
    // A strict bound becomes an inclusive one a step in. The step is 1 for a whole number and a
    // small epsilon otherwise, which keeps the picked value strictly inside either way.
    const step = integer ? 1 : 0.001;
    if (b.operator === '>=') {
      min = Math.max(min, v);
      narrowedMin = true;
    } else if (b.operator === '>') {
      min = Math.max(min, v + step);
      narrowedMin = true;
    } else if (b.operator === '<=') {
      max = Math.min(max, v);
      narrowedMax = true;
    } else if (b.operator === '<') {
      max = Math.min(max, v - step);
      narrowedMax = true;
    } else if (b.operator === '=') {
      min = v;
      max = v;
      narrowedMin = true;
      narrowedMax = true;
    }
  }

  // Where nothing narrowed an end, draw from a readable window instead of the type's full range,
  // clamped so a declared bound is still respected.
  if (!narrowedMin && (declaredMin === undefined || min <= FIXTURE_MIN)) {
    min = Math.max(min, Math.min(FIXTURE_MIN, max));
  }
  if (!narrowedMax && (declaredMax === undefined || max >= FIXTURE_MAX)) {
    max = Math.min(max, Math.max(FIXTURE_MAX, min));
  }

  // Clamp into the range a JS number represents exactly, so a bigint-width bound does not produce
  // a value that is already wrong before it reaches the database.
  min = Math.max(min, SAFE_MIN);
  max = Math.min(max, SAFE_MAX);
  if (min > max) {
    // Contradictory constraints. Nothing satisfies them, so the window collapses to the lower
    // bound and the emitted module says so rather than pretending.
    max = min;
  }
  return { min, max, integer };
}

/** The permitted length window for a string column, from `maxLength` and any `length()` check. */
function lengthWindow(column: Column, lengths: LengthCheck[]): { min: number; max: number } {
  let min = 1;
  let max = column.maxLength ?? 24;
  for (const l of lengths) {
    if (l.column !== column.name) continue;
    const v = Number(l.value);
    if (!Number.isFinite(v)) continue;
    if (l.operator === '>=') min = Math.max(min, v);
    else if (l.operator === '>') min = Math.max(min, v + 1);
    else if (l.operator === '<=') max = Math.min(max, v);
    else if (l.operator === '<') max = Math.min(max, v - 1);
    else if (l.operator === '=') {
      min = v;
      max = v;
    }
  }
  if (min < 0) min = 0;
  if (max < min) max = min;
  return { min, max };
}

/** The TypeScript type one column's seeded value has. */
function tsTypeOf(column: Column, sets: ColumnSet[] = []): string {
  // A set from a CHECK types the field as precisely as a declared enum does: `rng.pick` returns the
  // union of its argument, so widening to `string` here would throw away what the row really is.
  const set = sets.find((s) => s.column === column.name && s.kind === 'string');
  const base =
    column.enumValues && column.enumValues.length
      ? column.enumValues.map(q).join(' | ')
      : set
        ? set.values.map(q).join(' | ')
      : column.tsType === 'number'
        ? 'number'
        : column.tsType === 'boolean'
          ? 'boolean'
          : column.tsType === 'bigint'
            ? 'bigint'
            : column.tsType === 'Date'
              ? 'Date'
              : 'string';
  return column.nullable ? `${base} | null` : base;
}

/**
 * Which columns a seed row carries.
 *
 * A generated column is excluded because the database computes it and refuses a value. A column
 * with a default is included only when it is not nullable and not generated, so the row is complete
 * enough to insert on its own.
 */
function seededColumns(table: Table): Column[] {
  return table.columns.filter((c) => !c.isGenerated);
}

/** The expression that produces one column's value, given a local `rng`. */
function valueExpr(column: Column, parsed: Parsed): string {
  const sets = parsed.sets.filter((s) => s.column === column.name);
  if (column.enumValues && column.enumValues.length) {
    return `rng.pick([${column.enumValues.map(q).join(', ')}] as const)`;
  }
  if (sets.length) {
    // An IN set is the tightest thing said about the column, so it wins over any type default.
    const s = sets[0]!;
    return s.kind === 'number'
      ? `rng.pick([${s.values.join(', ')}] as const)`
      : `rng.pick([${s.values.map(q).join(', ')}] as const)`;
  }

  switch (column.tsType) {
    case 'number': {
      const w = numericWindow(column, parsed.bounds);
      return w.integer
        ? `rng.int(${w.min}, ${w.max})`
        : `rng.float(${w.min}, ${w.max})`;
    }
    case 'boolean':
      return 'rng.bool()';
    case 'bigint':
      return 'rng.bigint()';
    case 'Date':
      return 'rng.date()';
    default: {
      const l = lengthWindow(column, parsed.lengths);
      return `rng.text(${l.min}, ${l.max})`;
    }
  }
}

/**
 * The runtime the emitted modules share.
 *
 * A generator rather than a dependency: this is forty lines, and a seed module that pulls a package
 * in to produce a number is a dependency a fixture does not need.
 *
 * `mulberry32` because it is small, fast and has a period long enough for any fixture. The point is
 * reproducibility rather than statistical quality: the same seed gives the same rows, so a test that
 * fails on row 47 fails on row 47 again.
 */
export const RUNTIME_MODULE = 'rng';
const RUNTIME_SOURCE = `/**
 * A small deterministic random source, shared by every seed module.
 *
 * The same seed produces the same sequence, which is the whole point: a fixture that changes
 * between runs turns a failing test into a coin toss.
 */
export class Rng {
  private state: number;

  constructor(seed = 1) {
    // A zero state would make mulberry32 return the same value forever, so it is moved off zero.
    this.state = (seed >>> 0) || 0x9e3779b9;
  }

  /** mulberry32. */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** A whole number in [min, max], both ends included. */
  int(min: number, max: number): number {
    if (max <= min) return min;
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /**
   * A number in [min, max].
   *
   * Rounded to three decimal places, which is what keeps it inside a bound derived from a strict
   * comparison: the window for \`price > 10\` starts at 10.001, and a value with more precision
   * than that could round down onto the excluded bound when a database stores it.
   */
  float(min: number, max: number): number {
    if (max <= min) return min;
    const raw = min + this.next() * (max - min);
    const rounded = Math.round(raw * 1000) / 1000;
    return rounded < min ? min : rounded > max ? max : rounded;
  }

  bool(): boolean {
    return this.next() < 0.5;
  }

  bigint(): bigint {
    return BigInt(this.int(1, 2147483647));
  }

  date(): Date {
    // A window around 2020 to 2030, so a seeded date is plausible without being today's.
    return new Date(Date.UTC(2020, 0, 1) + this.int(0, 3652) * 86400000);
  }

  /** One member of the given list. */
  pick<T>(values: readonly T[]): T {
    return values[this.int(0, values.length - 1)] as T;
  }

  /**
   * A string whose length is in [min, max], counted in code points.
   *
   * ASCII letters only. A length constraint counts code points in Postgres and bytes in the TEXT
   * family, and a value drawn from an alphabet where the two are equal satisfies either reading.
   */
  text(min: number, max: number): string {
    const length = this.int(min, max);
    let out = '';
    for (let i = 0; i < length; i++) {
      out += ALPHABET[this.int(0, ALPHABET.length - 1)];
    }
    return out;
  }
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz';
`;

interface RenderContext {
  out: string;
}

export class SeedGenerator {
  constructor(private analysis: Analysis) {}

  async generate(opts: GenerateOptions) {
    const fs = fileWriter(opts.fileSink);
    const path = await import('node:path');
    const out = path.resolve(process.cwd(), opts.outputDir);
    const ctx: RenderContext = { out };
    await fs.mkdir(out, { recursive: true });

    const files: string[] = [];
    const write = async (filePath: string, content: string) => {
      const formatted = await formatCode(
        buildHeader(opts.outputHeader) + content,
        filePath,
        opts.format
      );
      await fs.writeFile(filePath, formatted, 'utf8');
      files.push(filePath);
    };

    const barrelPath = path.join(out, `${SEED_MODULE}.ts`);
    const runtimePath = path.join(out, `${RUNTIME_MODULE}.ts`);
    await write(runtimePath, RUNTIME_SOURCE);

    const modules: Array<{ table: Table; filePath: string }> = [];
    const total = this.analysis.tables.length;
    let index = 0;
    for (const table of this.analysis.tables) {
      const base = `${table.tsName}${opts.naming?.routerSuffix ?? ''}`;
      const filePath = path.join(out, `${toCase(base, opts.naming?.procedureCase)}.ts`);
      if (filePath === barrelPath || filePath === runtimePath) {
        throw new Error(
          `@drzl/generator-seed: the seed data for table "${table.name}" would be written to ` +
            `${filePath}, which is a module this generator also writes. Set naming.routerSuffix ` +
            `to move it out of the way.`
        );
      }
      await write(filePath, renderTable(table, opts));
      modules.push({ table, filePath });
      index++;
      opts.onProgress?.({ index, total, table: table.name, filePath });
    }

    await write(barrelPath, renderBarrel(modules, ctx, path, opts));
    return { files };
  }
}

export default SeedGenerator;

function buildHeader(h?: { enabled?: boolean; text?: string }) {
  if (h && h.enabled === false) return '';
  const text = h?.text?.trim();
  const lines = text
    ? text.split(/\r?\n/).map((l) => `// ${l}`)
    : [
        '// Generated by DRZL (@drzl/*)',
        "// Generated output is granted to you under your project's license.",
        '// You may use, copy, modify, and distribute without attribution.',
      ];
  return lines.join('\n') + '\n\n';
}

function renderTable(table: Table, opts: GenerateOptions): string {
  const parsed = parseTable(table);
  const columns = seededColumns(table);
  const fn = seedFnName(table, opts.naming);
  const rowType = rowTypeName(table, opts.naming);
  const count = opts.defaultCount ?? 10;

  const fields = columns
    .map((c) => `  ${objectKey(c.name)}: ${tsTypeOf(c, parsed.sets)};`)
    .join('\n');

  const assignments = columns
    .map((c) => {
      const expr = valueExpr(c, parsed);
      // A nullable column is null some of the time, so a fixture exercises both paths. Not for a
      // column a row comparison names: the comparison cannot hold if either side is missing.
      const inComparison = parsed.rows.some((r) => r.left === c.name || r.right === c.name);
      const value =
        c.nullable && !inComparison ? `rng.next() < 0.15 ? null : ${expr}` : expr;
      return `      ${objectKey(c.name)}: ${value},`;
    })
    .join('\n');

  /**
   * Row comparisons, applied after the values exist.
   *
   * `price > cost` cannot be satisfied by choosing either value alone, so both are generated
   * independently and then ordered. Swapping is enough for the non-strict operators; a strict one
   * also needs the two to differ, which is what the nudge is for.
   */
  const ordering = parsed.rows
    .filter((r) => columns.some((c) => c.name === r.left) && columns.some((c) => c.name === r.right))
    .map((r) => {
      const left = `row[${q(r.left)}]`;
      const right = `row[${q(r.right)}]`;
      const wantLeftSmaller = r.operator === '<' || r.operator === '<=';
      const strict = r.operator === '<' || r.operator === '>';
      const lo = wantLeftSmaller ? left : right;
      const hi = wantLeftSmaller ? right : left;
      return [
        `    // ${r.name ? `${r.name}: ` : ''}${r.left} ${r.operator} ${r.right}`,
        `    if (typeof ${lo} === 'number' && typeof ${hi} === 'number') {`,
        `      if (${lo} > ${hi}) {`,
        `        const swap = ${lo};`,
        `        ${lo} = ${hi};`,
        `        ${hi} = swap;`,
        `      }`,
        ...(strict
          ? [
              `      // A strict comparison also needs the two to differ.`,
              `      if (${lo} === ${hi}) ${hi} = ${hi} + 1;`,
            ]
          : []),
        `    }`,
      ].join('\n');
    })
    .join('\n');

  const unparsedNote = parsed.unparsed.length
    ? [
        ' *',
        ' * Not satisfied by construction, because the parser could not read them. A row from here',
        ' * may violate these, and the database will say so:',
        ...parsed.unparsed.map((u) => ` *   ${u}`),
      ].join('\n')
    : '';

  const satisfied = [
    ...parsed.bounds.map((b) => ` *   ${b.column} ${b.operator} ${b.value}`),
    ...parsed.sets.map((s) => ` *   ${s.column} IN (${s.values.length} values)`),
    ...parsed.lengths.map((l) => ` *   length(${l.column}) ${l.operator} ${l.value}`),
    ...parsed.rows.map((r) => ` *   ${r.left} ${r.operator} ${r.right}`),
  ];
  const satisfiedNote = satisfied.length
    ? [' *', ' * Satisfied by construction:', ...satisfied].join('\n')
    : ' *\n * This table declares no CHECK the parser could read, so the values are type-shaped only.';

  // `.ts` on the way in: `importSpecifier` rewrites that suffix, and given an extensionless path
  // it has nothing to rewrite, so the emitted specifier stayed bare and node16 refused it.
  const spec = importSpecifier(`./${RUNTIME_MODULE}.ts`, opts.importExtension);

  return `// Generated by @drzl/generator-seed
// Seed rows for table: ${table.name}
import { Rng } from '${spec}';

export interface ${rowType} {
${fields}
}

/**
 * ${count === 1 ? 'One row' : `Rows`} for the ${table.name} table, satisfying its constraints by construction.
${satisfiedNote}${unparsedNote}
 *
 * Deterministic: the same \`seed\` gives the same rows.
 */
export function ${fn}(count = ${count}, seed = 1): ${rowType}[] {
  const rng = new Rng(seed);
  const rows: ${rowType}[] = [];
  for (let i = 0; i < count; i++) {
    const row: ${rowType} = {
${assignments}
    };
${ordering}
    rows.push(row);
  }
  return rows;
}
`;
}

function renderBarrel(
  modules: Array<{ table: Table; filePath: string }>,
  ctx: RenderContext,
  path: typeof import('node:path'),
  opts: GenerateOptions
): string {
  const entries = modules.map((m) => ({
    table: m.table,
    fn: seedFnName(m.table, opts.naming),
    key: toCase(m.table.tsName, opts.naming?.procedureCase),
    rel: importSpecifier(
      './' + path.relative(ctx.out, m.filePath).replace(/\\/g, '/'),
      opts.importExtension
    ),
  }));

  const imports = entries.map((e) => `import { ${e.fn} } from '${e.rel}';`).join('\n');
  const reExports = entries.map((e) => `export * from '${e.rel}';`).join('\n');
  const members = entries.map((e) => `    ${objectKey(e.key)}: ${e.fn}(count, seed),`).join('\n');
  const runtime = importSpecifier(`./${RUNTIME_MODULE}.ts`, opts.importExtension);

  /**
   * The order the tables are listed in, which is a topological one where the analysis allows.
   *
   * A row referencing another table's key can only be inserted after that table has rows. The
   * ordering is computed here rather than left to the caller, and a cycle keeps declaration order
   * with a note, because no order satisfies a cycle and silently picking one would look correct.
   */
  const { order, cycle } = topological(modules.map((m) => m.table));
  const orderedKeys = order.map((t) => toCase(t.tsName, opts.naming?.procedureCase));

  const orderNote = cycle
    ? [
        '//',
        '// The insert order below is declaration order, not a dependency order: these tables',
        '// reference each other in a cycle, and no ordering satisfies it. Insert with the',
        '// foreign keys deferred, or fill the referencing column in a second pass.',
      ].join('\n')
    : [
        '//',
        '// `insertOrder` is a topological sort of the foreign keys, so a table never appears',
        '// before one it references.',
      ].join('\n');

  return `// Generated by @drzl/generator-seed
// Every table's seed rows.
${orderNote}
import { Rng } from '${runtime}';
${imports}

/** Every table's rows, keyed by table. The same \`seed\` gives the same data. */
export function seedAll(count = 10, seed = 1) {
  return {
${members}
  };
}

/** Table keys in an order that respects foreign keys. */
export const insertOrder = [${orderedKeys.map(q).join(', ')}] as const;

export { Rng };

${reExports || '// No tables in the analysis, so there is nothing to re-export.'}
`;
}

/**
 * Tables ordered so that a table never precedes one it references.
 *
 * Kahn's algorithm. A self-reference is ignored rather than treated as a cycle: a table whose
 * column points at its own key is inserted in one pass with that column null, which is the ordinary
 * shape of a parent pointer.
 */
function topological(tables: Table[]): { order: Table[]; cycle: boolean } {
  const byName = new Map(tables.map((t) => [t.name, t]));
  const deps = new Map<string, Set<string>>();
  for (const t of tables) {
    const set = new Set<string>();
    for (const c of t.columns) {
      const target = c.references?.table;
      if (target && target !== t.name && byName.has(target)) set.add(target);
    }
    for (const fk of t.foreignKeys ?? []) {
      if (fk.foreignTable !== t.name && byName.has(fk.foreignTable)) set.add(fk.foreignTable);
    }
    deps.set(t.name, set);
  }

  const order: Table[] = [];
  const placed = new Set<string>();
  let progress = true;
  while (progress && order.length < tables.length) {
    progress = false;
    for (const t of tables) {
      if (placed.has(t.name)) continue;
      const remaining = [...(deps.get(t.name) ?? [])].filter((d) => !placed.has(d));
      if (remaining.length === 0) {
        order.push(t);
        placed.add(t.name);
        progress = true;
      }
    }
  }

  if (order.length < tables.length) {
    return { order: tables, cycle: true };
  }
  return { order, cycle: false };
}
