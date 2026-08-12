import type { Column, Table } from '@drzl/analyzer';
import { parseCheck, type ColumnCheck } from './checks.js';

/**
 * What one column is, in the terms a form control needs.
 *
 * Every validation generator already folds a table's `CHECK` constraints into the bounds it emits,
 * and every one of them does it with a private copy of the same loop. A form generator reading
 * `Column.min` and `Column.max` directly would be a fourth derivation and a wrong one: measured
 * 2026-08-12, a column carrying `check('adult', age >= 18)` still reports
 * `min: '-2147483648'`, the plain int32 range, because the analyzer leaves checks on the table and
 * the generators fold them at emit time. An input rendered from that would carry
 * `min="-2147483648"`, which looks like a bound and is not one.
 *
 * So the fold lives here, beside `classifyTableChecks` and `tableConstraints`, which are already
 * the shared home for the same question. `fieldFacts` is what a form generator reads, and what the
 * emitted schema's own bounds agree with by construction rather than by coincidence.
 */
export interface FieldFacts {
  /** The column, under the TypeScript name a generated schema spells. */
  name: string;
  /** The input type a control should use, derived from the column's TypeScript type. */
  control: 'text' | 'number' | 'checkbox' | 'datetime-local' | 'select';
  /**
   * Whether a value has to be supplied on insert.
   *
   * False for a nullable column and for one carrying a default, since the database fills it. This
   * is the insert-side answer; a select-side reader wants `nullable` instead.
   */
  required: boolean;
  nullable: boolean;
  /** `maxlength`, from a declared width. Absent on an unbounded text column. */
  maxLength?: number;
  /**
   * `min` and `max`, as text.
   *
   * Text because a 64 bit bound is not representable as a JS number, which is the same reason the
   * analyzer reports them that way. Narrowed by any `CHECK` on the column: a check replaces the end
   * it constrains rather than sitting beside it, and it can never widen, because the declared range
   * is the column's type and no check makes an int32 hold more.
   */
  min?: string;
  max?: string;
  /** Whether either bound is exclusive, which HTML cannot express and a validator can. */
  exclusiveMin?: boolean;
  exclusiveMax?: boolean;
  /** `step="1"` for an integer column. */
  integer?: boolean;
  /** The options a `<select>` should carry, from a native enum or a declared set. */
  options?: string[];
  /** A `pattern` where the column's format implies one and HTML can state it. */
  pattern?: string;
  /** The default the database applies, for a form's initial value. */
  defaultValue?: unknown;
}

/** `uuid` is the one format with a pattern short enough to be worth putting on an input. */
const UUID_PATTERN = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';

/** Which control a column's TypeScript type asks for. A set of options always wins. */
function controlFor(c: Column): FieldFacts['control'] {
  if (c.enumValues?.length) return 'select';
  if (c.tsType === 'boolean') return 'checkbox';
  if (c.tsType === 'number' || c.tsType === 'bigint') return 'number';
  if (c.tsType === 'Date') return 'datetime-local';
  return 'text';
}

/**
 * The column's bounds, narrowed by the checks that apply to it.
 *
 * The same fold `numericBounds` performs in the zod generator, kept in one place so an input's
 * `min` and a schema's `.gte()` cannot disagree about the same column.
 */
function boundsFor(
  c: Column,
  checks: ColumnCheck[]
): Pick<FieldFacts, 'min' | 'max' | 'exclusiveMin' | 'exclusiveMax'> {
  let lo = c.min !== undefined ? { value: c.min, exclusive: false } : undefined;
  let hi = c.max !== undefined ? { value: c.max, exclusive: false } : undefined;

  for (const k of checks) {
    if (k.column !== c.name || k.kind !== 'number') continue;
    if (k.operator === '>=') lo = { value: k.value, exclusive: false };
    else if (k.operator === '>') lo = { value: k.value, exclusive: true };
    else if (k.operator === '<=') hi = { value: k.value, exclusive: false };
    else if (k.operator === '<') hi = { value: k.value, exclusive: true };
  }

  return {
    ...(lo ? { min: lo.value, ...(lo.exclusive ? { exclusiveMin: true } : {}) } : {}),
    ...(hi ? { max: hi.value, ...(hi.exclusive ? { exclusiveMax: true } : {}) } : {}),
  };
}

/**
 * Every column of a table, as the facts a form control needs.
 *
 * Generated columns are left out: the database computes them and no form supplies one.
 */
export function fieldFacts(table: Table): FieldFacts[] {
  const parsed = (table.checks ?? []).map((k) =>
    parseCheck(k.expression, k.name, table.dialect)
  );
  const ok = parsed.filter((p): p is Extract<typeof p, { ok: true }> => !!p && p.ok);
  const columnChecks = ok.flatMap((p) => p.checks ?? []);
  // `CHECK (length(bio) <= 500)` is a maxlength the column's type never declared, and it is the one
  // way an unbounded `text` column gets a real limit. Only the character measure is taken: a byte
  // count is not a character count, and `maxlength` on an input counts characters.
  const lengthChecks = ok.flatMap((p) => p.lengths ?? []);

  return table.columns
    .filter((c) => !c.isGenerated)
    .map((c) => ({
      name: c.name,
      control: controlFor(c),
      // A column the database fills is not one a form has to supply, which is the insert-side
      // question a form asks. `nullable` is reported beside it for a reader asking the other one.
      required: !c.nullable && !c.hasDefault,
      nullable: c.nullable,
      ...(() => {
        const declared = c.maxLength;
        const fromCheck = lengthChecks
          .filter(
            (l) =>
              l.column === c.name &&
              (l.unit ?? 'characters') === 'characters' &&
              (l.operator === '<=' || l.operator === '<')
          )
          .map((l) => (l.operator === '<' ? Number(l.value) - 1 : Number(l.value)))
          .filter((n) => Number.isFinite(n));
        const all = [...(declared !== undefined ? [declared] : []), ...fromCheck];
        // The tightest wins. A check can only narrow, exactly as a numeric bound can.
        return all.length ? { maxLength: Math.min(...all) } : {};
      })(),
      ...boundsFor(c, columnChecks),
      ...(c.integer ? { integer: true } : {}),
      ...(c.enumValues?.length ? { options: [...c.enumValues] } : {}),
      ...(c.format === 'uuid' ? { pattern: UUID_PATTERN } : {}),
      ...(c.defaultValue !== undefined ? { defaultValue: c.defaultValue } : {}),
    }));
}
