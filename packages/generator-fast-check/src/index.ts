import { fileWriter, type FileSink } from '@drzl/validation-core';
import type { Analysis, Column, Table } from '@drzl/analyzer';
import type { ImportExtension } from '@drzl/validation-core';
import { formatCode, importSpecifier, parseCheck } from '@drzl/validation-core';
import type { ColumnCheck, ColumnSet, LengthCheck, RowCheck } from '@drzl/validation-core';

/**
 * fast-check arbitraries, one per table, bounded by every constraint the analyzer parsed.
 *
 * A property test is only as good as the values it draws, and a hand-written arbitrary for a
 * constrained column is where two mistakes get made. The first is the obvious one: nothing in
 * `fc.integer()` knows the column carries `CHECK (quantity BETWEEN 1 AND 999)`, so the test spends
 * most of its runs on rows the database would refuse, and the property under test is never really
 * exercised.
 *
 * The second is worse, because it looks correct. **Explicit bounds do not exclude NaN.** Measured
 * against `fast-check@4.9.0` on 2026-08-11: `fc.double({ min: 0, max: 100 })` produced 86 NaN in
 * 30,000 samples, about one in 350, with no value outside the range and no infinity. So a bounded
 * float column gets a NaN roughly every 350 runs, the database refuses it, and the failure lands in
 * CI on a case nobody can reproduce locally. `noNaN: true` removes them, and nothing about writing
 * the bounds by hand suggests it is needed.
 *
 * DRZL answers that per column rather than blanket-disabling it, which is the part a hand-written
 * arbitrary cannot easily do. `allowsNaN` and `allowsInfinity` are measured against real servers and
 * are not uniform: Postgres stores NaN and both infinities in `real` and `double precision`, a
 * `numeric(10,2)` takes NaN and refuses either infinity, and `integer`/`bigint` refuse all three. So
 * a column that really does store NaN keeps getting one, and only the columns that cannot hold it
 * have it excluded.
 *
 * This shares its constraint reading with `@drzl/generator-seed` and deliberately differs from it in
 * one place. The seed generator narrows an unconstrained numeric to a readable window, because a
 * fixture is there to be looked at. An arbitrary should stay exactly as wide as the column really
 * is, because a property test *wants* the awkward values.
 */

export type Case = 'camel' | 'kebab' | 'snake';

export interface NamingOptions {
  /** Appended to `tsName` for the file name and the exported identifier. */
  routerSuffix?: string;
  /** Casing applied to file names and identifiers. */
  procedureCase?: Case;
}

/** The barrel's filename stem. */
export const ARBITRARY_MODULE = 'index';

export interface GenerateOptions {
  outputDir: string;
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

function baseName(table: Table, naming?: NamingOptions): string {
  const c = naming?.procedureCase;
  return toCase(`${table.tsName}${naming?.routerSuffix ?? ''}`, c === 'kebab' ? 'camel' : c);
}

function arbitraryName(table: Table, naming?: NamingOptions): string {
  return `${baseName(table, naming)}Arbitrary`;
}

function rowTypeName(table: Table, naming?: NamingOptions): string {
  return `${cap(baseName(table, naming))}Row`;
}

/** Everything one table's CHECKs said, in the shapes this generator acts on. */
interface Parsed {
  bounds: ColumnCheck[];
  sets: ColumnSet[];
  rows: RowCheck[];
  lengths: LengthCheck[];
  unparsed: string[];
}

function parseTable(table: Table): Parsed {
  const out: Parsed = { bounds: [], sets: [], rows: [], lengths: [], unparsed: [] };
  for (const k of table.checks ?? []) {
    const parsed = parseCheck(k.expression, k.name, table.dialect);
    if (!parsed.ok) {
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

const SAFE_MIN = -9007199254740991;
const SAFE_MAX = 9007199254740991;

interface Window {
  min: number;
  max: number;
  integer: boolean;
  /** Whether either end was actually stated, which decides if a bound is emitted at all. */
  bounded: boolean;
}

/**
 * The numeric window a column's values have to land in.
 *
 * Both sources are intersected: the column's declared range comes from its SQL type, and a CHECK
 * narrows it further. Unlike the seed generator, an unbounded column stays unbounded here, so the
 * arbitrary keeps drawing the extreme values a property test is for.
 */
function numericWindow(column: Column, bounds: ColumnCheck[]): Window {
  const integer = column.integer ?? false;
  const declaredMin = column.min !== undefined ? Number(column.min) : undefined;
  const declaredMax = column.max !== undefined ? Number(column.max) : undefined;
  let min = declaredMin !== undefined && Number.isFinite(declaredMin) ? declaredMin : SAFE_MIN;
  let max = declaredMax !== undefined && Number.isFinite(declaredMax) ? declaredMax : SAFE_MAX;
  let bounded = declaredMin !== undefined || declaredMax !== undefined;

  for (const b of bounds) {
    if (b.column !== column.name || b.kind !== 'number') continue;
    const v = Number(b.value);
    if (!Number.isFinite(v)) continue;
    // fast-check's ranges are inclusive at both ends, measured, so a strict bound moves one step in.
    const step = integer ? 1 : Number.EPSILON * Math.max(1, Math.abs(v));
    if (b.operator === '>=') min = Math.max(min, v);
    else if (b.operator === '>') min = Math.max(min, v + step);
    else if (b.operator === '<=') max = Math.min(max, v);
    else if (b.operator === '<') max = Math.min(max, v - step);
    else if (b.operator === '=') {
      min = v;
      max = v;
    }
    bounded = true;
  }

  min = Math.max(min, SAFE_MIN);
  max = Math.min(max, SAFE_MAX);
  if (min > max) max = min;
  return { min, max, integer, bounded };
}

/** The permitted length window for a string column, from `maxLength` and any `length()` check. */
function lengthWindow(column: Column, lengths: LengthCheck[]): { min?: number; max?: number } {
  let min: number | undefined;
  let max: number | undefined = column.maxLength;
  for (const l of lengths) {
    if (l.column !== column.name) continue;
    const v = Number(l.value);
    if (!Number.isFinite(v)) continue;
    if (l.operator === '>=') min = Math.max(min ?? 0, v);
    else if (l.operator === '>') min = Math.max(min ?? 0, v + 1);
    else if (l.operator === '<=') max = Math.min(max ?? Infinity, v);
    else if (l.operator === '<') max = Math.min(max ?? Infinity, v - 1);
    else if (l.operator === '=') {
      min = v;
      max = v;
    }
  }
  if (min !== undefined && min < 0) min = 0;
  if (max !== undefined && min !== undefined && max < min) max = min;
  return { min, max };
}

/** The TypeScript type one column's value has. */
function tsTypeOf(column: Column, sets: ColumnSet[]): string {
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

/** The columns an arbitrary produces: everything the database does not compute itself. */
function generatedColumns(table: Table): Column[] {
  return table.columns.filter((c) => !c.isGenerated);
}

/** `{ min: 1, max: 999 }`, or nothing where neither end is stated. */
function rangeOptions(w: Window, extra: string[] = []): string {
  const parts: string[] = [];
  if (w.bounded) {
    parts.push(`min: ${w.min}`, `max: ${w.max}`);
  }
  parts.push(...extra);
  return parts.length ? `{ ${parts.join(', ')} }` : '';
}

/**
 * One column's arbitrary.
 *
 * The float branch is the one that matters. `noNaN` and `noDefaultInfinity` are set from what the
 * column actually accepts rather than always: a Postgres `double precision` really does store both,
 * and excluding them would stop a property test ever seeing a value the column holds.
 */
function arbitraryExpr(column: Column, parsed: Parsed): string {
  if (column.enumValues && column.enumValues.length) {
    return `fc.constantFrom(${column.enumValues.map(q).join(', ')})`;
  }
  const set = parsed.sets.find((s) => s.column === column.name);
  if (set) {
    return set.kind === 'number'
      ? `fc.constantFrom(${set.values.join(', ')})`
      : `fc.constantFrom(${set.values.map(q).join(', ')})`;
  }

  switch (column.tsType) {
    case 'number': {
      const w = numericWindow(column, parsed.bounds);
      if (w.integer) {
        const opts = rangeOptions(w);
        return opts ? `fc.integer(${opts})` : 'fc.integer()';
      }
      // The measured trap: bounds alone do not exclude NaN, so it is excluded explicitly wherever
      // the column cannot hold one. Same for an infinity.
      const extra: string[] = [];
      if (!column.allowsNaN) extra.push('noNaN: true');
      if (!column.allowsInfinity) extra.push('noDefaultInfinity: true');
      const opts = rangeOptions(w, extra);
      return opts ? `fc.double(${opts})` : 'fc.double()';
    }
    case 'boolean':
      return 'fc.boolean()';
    case 'bigint': {
      const w = numericWindow(column, parsed.bounds);
      return w.bounded ? `fc.bigInt({ min: ${w.min}n, max: ${w.max}n })` : 'fc.bigInt()';
    }
    case 'Date':
      return 'fc.date({ noInvalidDate: true })';
    default: {
      const l = lengthWindow(column, parsed.lengths);
      const parts: string[] = [];
      if (l.min !== undefined) parts.push(`minLength: ${l.min}`);
      if (l.max !== undefined && Number.isFinite(l.max)) parts.push(`maxLength: ${l.max}`);
      return parts.length ? `fc.string({ ${parts.join(', ')} })` : 'fc.string()';
    }
  }
}

/**
 * The helper a module carries when a strict row comparison needs two equal values separated.
 *
 * `hi + 1` is the obvious move and is wrong at the top of the range. Measured:
 * `Number.MAX_VALUE + 1 === Number.MAX_VALUE`, so a pair that both drew it stayed equal and the
 * constraint the map exists to keep was violated. `fc.double()` reaches that value on an
 * unconstrained column, and the failure only appeared on a different run's seed.
 *
 * A step scaled to the magnitude fixes it, and the direction has to be chosen rather than assumed.
 * Also measured: at `Number.MAX_VALUE` lowering is finite and raising overflows to `Infinity`; at
 * `-Number.MAX_VALUE` it is exactly the reverse. Every other finite value takes either.
 */
const SEPARATE = 'drzlSeparate';
const SEPARATE_SOURCE = `/**
 * Two numbers made strictly ordered, for a CHECK the database enforces strictly.
 *
 * Not \`hi + 1\`: \`Number.MAX_VALUE + 1\` is \`Number.MAX_VALUE\`, so a pair that both drew it would
 * stay equal. The step is scaled to the magnitude, and the direction is chosen because lowering
 * overflows at \`-Number.MAX_VALUE\` and raising overflows at \`Number.MAX_VALUE\`.
 *
 * \`step\` is 1 where both columns hold whole numbers, so the result stays whole.
 */
function ${SEPARATE}(lo: number, hi: number, step: number): [number, number] {
  if (lo < hi) return [lo, hi];
  const scaled = Math.max(step, Math.abs(lo) * Number.EPSILON);
  const lowered = lo - scaled;
  if (Number.isFinite(lowered) && lowered < hi) return [lowered, hi];
  const raised = hi + scaled;
  return [lo, Number.isFinite(raised) && raised > lo ? raised : hi];
}
`;

interface RenderContext {
  out: string;
}

export class FastCheckGenerator {
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

    const barrelPath = path.join(out, `${ARBITRARY_MODULE}.ts`);
    const modules: Array<{ table: Table; filePath: string }> = [];
    const total = this.analysis.tables.length;
    let index = 0;
    for (const table of this.analysis.tables) {
      const filePath = path.join(
        out,
        `${toCase(`${table.tsName}${opts.naming?.routerSuffix ?? ''}`, opts.naming?.procedureCase)}.ts`
      );
      if (filePath === barrelPath) {
        throw new Error(
          `@drzl/generator-fast-check: the arbitrary for table "${table.name}" would be written ` +
            `to ${filePath}, which is the ${ARBITRARY_MODULE}.ts this generator also writes. Set ` +
            `naming.routerSuffix to move it out of the way.`
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

export default FastCheckGenerator;

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
  const columns = generatedColumns(table);
  const arb = arbitraryName(table, opts.naming);
  const rowType = rowTypeName(table, opts.naming);

  const fields = columns.map((c) => `  ${objectKey(c.name)}: ${tsTypeOf(c, parsed.sets)};`).join('\n');

  const members = columns
    .map((c) => {
      const expr = arbitraryExpr(c, parsed);
      // A column a row comparison names is never null: the comparison cannot hold if either side
      // is missing, so `fc.option` would generate rows that fail the constraint it is meant to keep.
      const inComparison = parsed.rows.some((r) => r.left === c.name || r.right === c.name);
      const value =
        c.nullable && !inComparison ? `fc.option(${expr}, { nil: null })` : expr;
      return `  ${objectKey(c.name)}: ${value},`;
    })
    .join('\n');

  /**
   * Row comparisons, applied by mapping over the finished record.
   *
   * `price > cost` cannot be expressed as a per-column arbitrary at all: neither value alone can be
   * chosen to make it hold. Both are drawn independently and the pair is ordered afterwards, which
   * is also what keeps shrinking well behaved, since the map is a total function.
   */
  const applicable = parsed.rows.filter(
    (r) => columns.some((c) => c.name === r.left) && columns.some((c) => c.name === r.right)
  );

  const mapBody = applicable
    .map((r) => {
      const wantLeftSmaller = r.operator === '<' || r.operator === '<=';
      const strict = r.operator === '<' || r.operator === '>';
      const lo = wantLeftSmaller ? r.left : r.right;
      const hi = wantLeftSmaller ? r.right : r.left;
      // Whole numbers on both sides means the separation step stays whole too.
      const whole = [lo, hi].every((n) => columns.find((c) => c.name === n)?.integer === true);
      return [
        `    // ${r.name ? `${r.name}: ` : ''}${r.left} ${r.operator} ${r.right}`,
        `    if (typeof next[${q(lo)}] === 'number' && typeof next[${q(hi)}] === 'number') {`,
        `      if (next[${q(lo)}] > next[${q(hi)}]) {`,
        `        const swap = next[${q(lo)}];`,
        `        next[${q(lo)}] = next[${q(hi)}];`,
        `        next[${q(hi)}] = swap;`,
        `      }`,
        ...(strict
          ? [
              `      // A strict comparison also needs the two to differ, which \`+ 1\` cannot always do.`,
              `      [next[${q(lo)}], next[${q(hi)}]] = ${SEPARATE}(`,
              `        next[${q(lo)}],`,
              `        next[${q(hi)}],`,
              `        ${whole ? '1' : 'Number.MIN_VALUE'}`,
              `      );`,
            ]
          : []),
        `    }`,
      ].join('\n');
    })
    .join('\n');

  const record = `fc.record<${rowType}>({\n${members}\n})`;
  const body = applicable.length
    ? `${record}.map((row) => {\n    const next = { ...row };\n${mapBody}\n    return next;\n  })`
    : record;

  const satisfied = [
    ...parsed.bounds.map((b) => ` *   ${b.column} ${b.operator} ${b.value}`),
    ...parsed.sets.map((s) => ` *   ${s.column} IN (${s.values.length} values)`),
    ...parsed.lengths.map((l) => ` *   length(${l.column}) ${l.operator} ${l.value}`),
    ...applicable.map((r) => ` *   ${r.left} ${r.operator} ${r.right}`),
  ];
  const satisfiedNote = satisfied.length
    ? [' *', ' * Every value drawn satisfies:', ...satisfied].join('\n')
    : ' *\n * This table declares no CHECK the parser could read, so the bounds are the columns\' own.';

  const unparsedNote = parsed.unparsed.length
    ? [
        ' *',
        ' * Not bounded, because the parser could not read them. A drawn row may violate these:',
        ...parsed.unparsed.map((u) => ` *   ${u}`),
      ].join('\n')
    : '';

  const needsSeparate = applicable.some((r) => r.operator === '<' || r.operator === '>');

  return `// Generated by @drzl/generator-fast-check
// Arbitrary for table: ${table.name}
import fc from 'fast-check';
${needsSeparate ? `\n${SEPARATE_SOURCE}` : ''}

export interface ${rowType} {
${fields}
}

/**
 * Rows of the ${table.name} table, bounded by its constraints.
${satisfiedNote}${unparsedNote}
 */
export const ${arb}: fc.Arbitrary<${rowType}> = ${body};
`;
}

function renderBarrel(
  modules: Array<{ table: Table; filePath: string }>,
  ctx: RenderContext,
  path: typeof import('node:path'),
  opts: GenerateOptions
): string {
  const entries = modules.map((m) => ({
    ident: arbitraryName(m.table, opts.naming),
    key: toCase(m.table.tsName, opts.naming?.procedureCase),
    rel: importSpecifier(
      './' + path.relative(ctx.out, m.filePath).replace(/\\/g, '/'),
      opts.importExtension
    ),
  }));

  const imports = entries.map((e) => `import { ${e.ident} } from '${e.rel}';`).join('\n');
  const reExports = entries.map((e) => `export * from '${e.rel}';`).join('\n');
  const members = entries.map((e) => `  ${objectKey(e.key)}: ${e.ident},`).join('\n');

  return `// Generated by @drzl/generator-fast-check
// Every table's arbitrary, keyed by table.
${imports}

export const arbitraries = {
${members}
} as const;

${reExports || '// No tables in the analysis, so there is nothing to re-export.'}
`;
}
