/**
 * One place that decides what a generated identifier is called.
 *
 * Every generator used to build these names by hand with template literals, which is why
 * the oRPC router and the zod/valibot/arktype generators could silently disagree about the
 * same name. They all call through here now, so a single resolved value describes both
 * sides of the import.
 *
 * Defaults reproduce the pre-affix output byte for byte:
 *   schema: Insert|Update|Select + <tsName> + (schemaSuffix ?? 'Schema')
 *   type:   Insert|Update|Select + <tsName> + Input|Input|Output
 */

export type NameMode = 'insert' | 'update' | 'select';

/** How the Drizzle export name is cased before it goes into an identifier. */
export type TableCase = 'preserve' | 'pascal';

/** One affix for all three modes, or a per-mode override map. */
export type AffixValue = string | Partial<Record<NameMode, string>>;

export interface AffixOptions {
  /**
   * `preserve` (default) interpolates the Drizzle export name verbatim, which is what every
   * released version does: `export const users` yields `InsertusersSchema`. `pascal` upper-camels
   * it first, yielding `InsertUsersSchema`. Identifiers only; file names are never re-cased.
   */
  tableCase?: TableCase;
  /** Affixes for the exported schema constants. */
  schema?: { prefix?: AffixValue; suffix?: AffixValue };
  /** Affixes for the exported type aliases. Independent of `schema`. */
  type?: { prefix?: AffixValue; suffix?: AffixValue };
}

export interface ResolvedAffix {
  tableCase: TableCase;
  schema: { prefix: Record<NameMode, string>; suffix: Record<NameMode, string> };
  type: { prefix: Record<NameMode, string>; suffix: Record<NameMode, string> };
}

export interface AffixIssue {
  /** Path relative to the affix object, e.g. `['schema', 'suffix']`. */
  path: (string | number)[];
  message: string;
}

export const NAME_MODES: readonly NameMode[] = ['insert', 'update', 'select'];

export const DEFAULT_MODE_PREFIX: Readonly<Record<NameMode, string>> = {
  insert: 'Insert',
  update: 'Update',
  select: 'Select',
};

export const DEFAULT_TYPE_SUFFIX: Readonly<Record<NameMode, string>> = {
  insert: 'Input',
  update: 'Input',
  select: 'Output',
};

export const DEFAULT_SCHEMA_SUFFIX = 'Schema';

/** Table name used when a config is checked for invalid or colliding names. */
export const AFFIX_PROBE_TABLE = 'users';

function spread(
  value: AffixValue | undefined,
  fallback: Readonly<Record<NameMode, string>>
): Record<NameMode, string> {
  if (value === undefined) return { ...fallback };
  if (typeof value === 'string') return { insert: value, update: value, select: value };
  return {
    insert: value.insert ?? fallback.insert,
    update: value.update ?? fallback.update,
    select: value.select ?? fallback.select,
  };
}

/**
 * Real PascalCase, unlike the `cap()` helpers scattered around the repo which only upcase
 * character zero. Splits on `_`, `-`, whitespace and camel boundaries, and leaves the rest of
 * each part alone so acronyms survive (`userID` -> `UserID`, not `Userid`).
 */
export function pascalCase(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join('');
}

export function applyTableCase(tsName: string, tableCase: TableCase): string {
  return tableCase === 'pascal' ? pascalCase(tsName) : tsName;
}

/**
 * Fold an `affix` block and the legacy flat `schemaSuffix` into one fully-populated value.
 * `affix.schema.suffix` wins over `schemaSuffix`; `schemaSuffix` wins over the built-in
 * `'Schema'`. Calling with no arguments returns exactly today's naming.
 */
export function resolveAffix(opts?: {
  affix?: AffixOptions;
  schemaSuffix?: string;
}): ResolvedAffix {
  const affix = opts?.affix;
  const legacy = opts?.schemaSuffix ?? DEFAULT_SCHEMA_SUFFIX;
  const legacyMap: Record<NameMode, string> = {
    insert: legacy,
    update: legacy,
    select: legacy,
  };
  return {
    tableCase: affix?.tableCase ?? 'preserve',
    schema: {
      prefix: spread(affix?.schema?.prefix, DEFAULT_MODE_PREFIX),
      suffix: spread(affix?.schema?.suffix, legacyMap),
    },
    type: {
      prefix: spread(affix?.type?.prefix, DEFAULT_MODE_PREFIX),
      suffix: spread(affix?.type?.suffix, DEFAULT_TYPE_SUFFIX),
    },
  };
}

/** Name of the exported schema constant, e.g. `InsertusersSchema`. */
export function schemaName(mode: NameMode, tsName: string, affix: ResolvedAffix): string {
  return (
    affix.schema.prefix[mode] + applyTableCase(tsName, affix.tableCase) + affix.schema.suffix[mode]
  );
}

/** Name of the exported type alias, e.g. `InsertusersInput`. */
export function typeName(mode: NameMode, tsName: string, affix: ResolvedAffix): string {
  return (
    affix.type.prefix[mode] + applyTableCase(tsName, affix.tableCase) + affix.type.suffix[mode]
  );
}

// A prefix opens the identifier, so it may not start with a digit. A suffix never does.
const PREFIX_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const SUFFIX_RE = /^[A-Za-z0-9_$]+$/;

/**
 * Reject affixes that cannot produce a compilable file, before anything is written:
 *  - characters that are not legal in a TypeScript identifier
 *  - two names in the same declaration space resolving to the same string
 *
 * A schema name equal to a type name is allowed on purpose: `export const X` and
 * `export type X` occupy different declaration spaces, and the generators already emit
 * `type ... = z.input<typeof ...>` pairs.
 *
 * Only what the caller actually wrote in `affix` is checked. The legacy flat `schemaSuffix`
 * is not character-checked, because it never was, and rejecting it now would break configs
 * that parse today.
 */
export function validateAffix(affix?: AffixOptions, schemaSuffix?: string): AffixIssue[] {
  const issues: AffixIssue[] = [];
  if (!affix) return issues;

  const checkOne = (value: string, path: (string | number)[], kind: 'prefix' | 'suffix') => {
    if (value === '') return;
    const ok = kind === 'prefix' ? PREFIX_RE.test(value) : SUFFIX_RE.test(value);
    if (ok) return;
    issues.push({
      path,
      message:
        `${JSON.stringify(value)} cannot appear in a TypeScript identifier. Use only letters, ` +
        `digits, "_" and "$"` +
        (kind === 'prefix' ? ', and do not start with a digit.' : '.'),
    });
  };

  const checkValue = (
    value: AffixValue | undefined,
    base: (string | number)[],
    kind: 'prefix' | 'suffix'
  ) => {
    if (value === undefined) return;
    if (typeof value === 'string') {
      checkOne(value, base, kind);
      return;
    }
    for (const mode of NAME_MODES) {
      const v = value[mode];
      if (v !== undefined) checkOne(v, [...base, mode], kind);
    }
  };

  checkValue(affix.schema?.prefix, ['schema', 'prefix'], 'prefix');
  checkValue(affix.schema?.suffix, ['schema', 'suffix'], 'suffix');
  checkValue(affix.type?.prefix, ['type', 'prefix'], 'prefix');
  checkValue(affix.type?.suffix, ['type', 'suffix'], 'suffix');
  // Names built from broken parts are not worth reporting on top of the broken parts.
  if (issues.length) return issues;

  const resolved = resolveAffix({ affix, schemaSuffix });
  const collisions = (space: 'schema' | 'type', build: (mode: NameMode) => string): void => {
    const seen = new Map<string, NameMode>();
    for (const mode of NAME_MODES) {
      const name = build(mode);
      const first = seen.get(name);
      if (first) {
        issues.push({
          path: [space],
          message:
            `The ${space} names for "${first}" and "${mode}" collide: both resolve to ` +
            `"${name}". All three are emitted into the same file, so at least one prefix or ` +
            `suffix has to differ.`,
        });
      } else {
        seen.set(name, mode);
      }
    }
  };
  collisions('schema', (mode) => schemaName(mode, AFFIX_PROBE_TABLE, resolved));
  collisions('type', (mode) => typeName(mode, AFFIX_PROBE_TABLE, resolved));

  return issues;
}
