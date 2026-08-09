/**
 * What a bad `drzl.config` says, and what a silently-dropped key says instead of nothing.
 *
 * Two plan items, one file, because they are the same question asked at two levels of the config
 * schema. Both were measured on the built 4.22.0 CLI before anything here existed.
 *
 * **A validation failure printed the zod dump (item 78).** `ConfigSchema.parse` throws a
 * `ZodError` whose `.message` is a formatted JSON array of issue objects, and the CLI printed it
 * verbatim. A config that set `outDir: 123` produced eleven lines of JSON in which the word
 * `outDir` appeared once, inside a `path` array, three levels down. zod already knows which key
 * it was talking about; it was thrown away at the point of printing.
 *
 * **An unknown key produced no output at all (item 79).** `ConfigSchema` and `GeneratorSchema`
 * are both permissive, so zod strips a key it does not recognise and says nothing. Measured:
 * `outDirr: 'src/api'` at the root, `typedJsn: true` in a generator entry and
 * `validation: { librari: 'zod' }` in a nested object all generated normally and exited 0. This
 * repository has already shipped that failure twice from the other direction, as a documented
 * option the config schema did not declare (`databaseInjection`, `coerceDates`), and the user
 * side of it is identical: a setting that is written down, has no effect, and is never mentioned.
 *
 * The known keys at every level come from the JSON Schema `buildConfigJsonSchema()` derives from
 * `ConfigSchema` (item 64), rather than from a list maintained here. That matters for more than
 * duplication: `additionalProperties: false` appears in it exactly where the zod object is
 * `.strict()`, so the same walk distinguishes the levels zod refuses a key at from the levels it
 * drops one at, and neither can drift from the schema as the config grows.
 */

/** A JSON Schema node, read rather than validated against, so nothing here needs a resolver. */
type SchemaNode = Record<string, unknown>;

/**
 * An own property, without `Object.hasOwn`, which needs the ES2022 lib this repository does not
 * target, and without a bare `in`, which walks the prototype chain and would answer yes to
 * `constructor` and `toString` on every object walked here.
 */
function hasOwn(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

/** The code a config that does not parse reports, on stderr and in the `--json` document. */
export const CONFIG_INVALID_CODE = 'DRZL_CFG_002';

/**
 * A config that could not be parsed, carrying the code the failure document needs.
 *
 * A class rather than a `code` property on a plain `Error`, because the `generate` catch has to
 * tell this apart from every other throw, and `e.code` is a convention Node already uses:
 * `ENOENT` from a filesystem call would otherwise land in the `--json` document as though it
 * were one of ours.
 */
export class ConfigValidationError extends Error {
  readonly code = CONFIG_INVALID_CODE;
  constructor(message: string) {
    super(message);
    this.name = 'ConfigValidationError';
  }
}

/** The subset of a zod issue this file reads. Structural, so it is not tied to a zod version. */
export interface ConfigIssue {
  code?: string;
  path?: readonly PropertyKey[];
  message?: string;
  /** Present on `unrecognized_keys`, which is what a `.strict()` object produces. */
  keys?: readonly string[];
}

/** How many problems are listed before the rest are counted instead. */
const MAX_LISTED_PROBLEMS = 8;

/** How long a value may be before showing it costs more than it explains. */
const MAX_VALUE_CHARS = 60;

/**
 * A key path as a reader would write it: `generators[1].validation.library`.
 *
 * Not `generators.1.validation.library` and not the flattened blob zod prints. A path a user can
 * paste back into their own config file is the whole of item 78; anything else makes them count
 * array entries by hand.
 *
 * A key that is not an identifier is bracketed and quoted, because `columns` is keyed by table
 * pattern and `columns.app_*` reads as though `*` were part of the path language.
 */
export function renderConfigPath(segments: readonly PropertyKey[]): string {
  if (!segments.length) return '(root)';
  let out = '';
  for (const segment of segments) {
    if (typeof segment === 'number') {
      out += `[${segment}]`;
      continue;
    }
    const key = String(segment);
    if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) out += out ? `.${key}` : key;
    else out += `[${JSON.stringify(key)}]`;
  }
  return out;
}

/**
 * What the config actually said at that key, short enough to sit on the line.
 *
 * Numbers go through `String`, never `JSON.stringify`. `JSON.stringify(NaN)` is the four
 * characters `null`, and so is `JSON.stringify(Infinity)`, so a config written `nestedDepth: NaN`
 * would be reported as having said `null`: a different mistake, with a different fix, stated with
 * total confidence. That exact substitution has already turned one real defect in this repository
 * into a reasoned-through false conclusion.
 *
 * Returns `null` when there is nothing worth showing, which is what keeps a whole generator entry
 * out of a message about one of its keys.
 */
export function describeValue(value: unknown): string | null {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return String(value);
    case 'number':
      return String(value);
    case 'bigint':
      return `${value}n`;
    case 'function':
      return '[function]';
    case 'symbol':
      return String(value);
    case 'string':
      return value.length <= MAX_VALUE_CHARS
        ? JSON.stringify(value)
        : `${JSON.stringify(value.slice(0, MAX_VALUE_CHARS))} ... (${value.length} characters)`;
  }
  let json: string;
  try {
    json = JSON.stringify(value) as string;
  } catch {
    return null;
  }
  if (typeof json !== 'string') return null;
  return json.length <= MAX_VALUE_CHARS ? json : null;
}

/** The value the config really holds at a path, and whether the path leads anywhere at all. */
function valueAt(
  raw: unknown,
  segments: readonly PropertyKey[]
): { found: boolean; value: unknown } {
  let current: unknown = raw;
  for (const segment of segments) {
    if (current === null || typeof current !== 'object') return { found: false, value: undefined };
    // `hasOwn` rather than `in`, which walks the prototype chain: a path segment of `constructor`
    // or `toString` would otherwise be reported as a value the config states.
    if (!hasOwn(current, String(segment))) return { found: false, value: undefined };
    current = (current as Record<PropertyKey, unknown>)[segment as never];
  }
  return { found: true, value: current };
}

/**
 * Levenshtein distance, iteratively over two rows.
 *
 * Written here rather than installed. Config keys are a handful of characters and there are under
 * forty of them, so this costs nothing worth measuring, and a dependency added to suggest a
 * spelling is a dependency on every install of the CLI for ever.
 */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = new Array<number>(b.length + 1);
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const substitution = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, substitution);
    }
    previous = current;
  }
  return previous[b.length];
}

/**
 * The key the writer probably meant, or nothing.
 *
 * A typo, not a different word. One edit for a short key and two for anything from five
 * characters up: `librari` to `library` is one, `typedJsn` to `typedJson` is one, `outDirr` to
 * `outDir` is one, and `abc` to `kind` is three, which is somebody meaning something else. A
 * wrong suggestion is worse than none, because it sends a reader to change a line that was right.
 *
 * Ties go to the earliest known key, which is schema declaration order, so the suggestion for a
 * given typo is the same on every run.
 */
export function nearestKey(key: string, known: readonly string[]): string | undefined {
  const budget = key.length >= 5 ? 2 : 1;
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of known) {
    if (candidate === key) return undefined;
    const distance = editDistance(key, candidate);
    if (distance <= budget && distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * The object description at a node, seeing through a `anyOf`.
 *
 * A union is only followed when exactly one of its branches describes an object. Two would mean
 * guessing which one the value was written against, and a wrong guess reports keys that are
 * perfectly valid, which is the one outcome item 79 must not produce.
 */
function objectNodeFor(node: unknown): SchemaNode | undefined {
  if (!node || typeof node !== 'object') return undefined;
  const record = node as SchemaNode;
  const anyOf = record.anyOf;
  if (Array.isArray(anyOf)) {
    const branches = anyOf.filter(
      (branch) =>
        branch &&
        typeof branch === 'object' &&
        ((branch as SchemaNode).properties !== undefined ||
          typeof (branch as SchemaNode).additionalProperties === 'object')
    ) as SchemaNode[];
    return branches.length === 1 ? branches[0] : undefined;
  }
  if (record.properties !== undefined || record.additionalProperties !== undefined) return record;
  return undefined;
}

/** One key the config states and the schema does not declare. */
export interface UnknownConfigKey {
  /** Where the object holding it lives, as instance-path segments. */
  path: readonly PropertyKey[];
  key: string;
  suggestion?: string;
}

/**
 * Every key a permissive level of the config schema would drop in silence.
 *
 * Strict levels are skipped deliberately: zod refuses those outright, so nothing reaches this
 * walk with one set, and `formatConfigProblems` gives that refusal the same key path and the same
 * suggestion this produces. Record levels are skipped too, and for the opposite reason: the keys
 * of `columns` are table patterns and the keys of `templateOptions` are a template's own options,
 * so there is no such thing as an unknown one there.
 */
export function unknownConfigKeys(raw: unknown, schema: SchemaNode): UnknownConfigKey[] {
  const found: UnknownConfigKey[] = [];
  walkForUnknownKeys(raw, schema, [], found);
  return found;
}

function walkForUnknownKeys(
  value: unknown,
  node: unknown,
  segments: PropertyKey[],
  found: UnknownConfigKey[]
): void {
  if (value === null || typeof value !== 'object') return;

  if (Array.isArray(value)) {
    const items = (node as SchemaNode | undefined)?.items;
    if (!items) return;
    value.forEach((entry, index) => walkForUnknownKeys(entry, items, [...segments, index], found));
    return;
  }

  const object = objectNodeFor(node);
  if (!object) return;

  const properties = object.properties as Record<string, unknown> | undefined;
  const additional = object.additionalProperties;

  if (!properties) {
    // A record. Only the values are described by the schema, so the keys are the user's data and
    // every one of them is legitimate.
    if (additional && typeof additional === 'object') {
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        walkForUnknownKeys(entry, additional, [...segments, key], found);
      }
    }
    return;
  }

  const known = Object.keys(properties);
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (hasOwn(properties, key)) {
      walkForUnknownKeys(entry, properties[key], [...segments, key], found);
      continue;
    }
    if (additional === false) continue;
    found.push({ path: [...segments], key, suggestion: nearestKey(key, known) });
  }
}

/** The warning lines for every key the config states and the schema drops. */
export function unknownKeyWarnings(raw: unknown, schema: SchemaNode): string[] {
  return unknownConfigKeys(raw, schema).map((unknown) => {
    const where = unknown.path.length ? `in ${renderConfigPath(unknown.path)}` : 'at the top level';
    const suggestion = unknown.suggestion ? ` Did you mean "${unknown.suggestion}"?` : '';
    return `drzl config: unknown key "${unknown.key}" ${where}; it is ignored.${suggestion}`;
  });
}

/** The schema node an instance path leads to, for reading the known keys off a strict object. */
function nodeAt(schema: SchemaNode, segments: readonly PropertyKey[]): SchemaNode | undefined {
  let node: unknown = schema;
  for (const segment of segments) {
    if (typeof segment === 'number') {
      node = (node as SchemaNode | undefined)?.items;
      continue;
    }
    const object = objectNodeFor(node);
    if (!object) return undefined;
    const properties = object.properties as Record<string, unknown> | undefined;
    if (properties && hasOwn(properties, String(segment))) {
      node = properties[String(segment)];
      continue;
    }
    const additional = object.additionalProperties;
    if (additional && typeof additional === 'object') {
      node = additional;
      continue;
    }
    return undefined;
  }
  return objectNodeFor(node);
}

/** The keys declared at a path, so a strict object's refusal can carry a suggestion too. */
function knownKeysAt(schema: SchemaNode, segments: readonly PropertyKey[]): string[] {
  const node = nodeAt(schema, segments);
  const properties = node?.properties as Record<string, unknown> | undefined;
  return properties ? Object.keys(properties) : [];
}

/** One issue, as one line: where it is, what is wrong, and what the file actually says. */
function renderIssue(issue: ConfigIssue, raw: unknown, schema: SchemaNode): string[] {
  const segments = issue.path ?? [];
  const where = renderConfigPath(segments);

  if (issue.code === 'unrecognized_keys' && issue.keys?.length) {
    const known = knownKeysAt(schema, segments);
    return issue.keys.map((key) => {
      const suggestion = nearestKey(key, known);
      return `${where}: unrecognized key "${key}".${suggestion ? ` Did you mean "${suggestion}"?` : ''}`;
    });
  }

  // zod prefixes every type failure with "Invalid input: ", which restates the header this line
  // already sits under.
  const what = String(issue.message ?? 'is not valid').replace(/^Invalid input:\s*/, '');
  const { found, value } = valueAt(raw, segments);
  const shown = found ? describeValue(value) : null;
  return [`${where}: ${what}${shown === null ? '' : ` (found ${shown})`}`];
}

/**
 * Every problem in a config that would not parse, one per line, each naming its key.
 *
 * All of them rather than the first, because a config written from an old example usually has
 * three or four problems of the same kind, and reporting one per run makes the user run the CLI
 * once per typo. Capped, because a config whose top-level shape is wrong can produce an issue per
 * key and a screen of them says less than eight and a count.
 *
 * The order is zod's, which is declaration order of the schema rather than of the file, and it is
 * stable across runs.
 */
export function formatConfigProblems(
  file: string,
  issues: readonly ConfigIssue[],
  raw: unknown,
  schema: SchemaNode
): string {
  const lines = issues.flatMap((issue) => renderIssue(issue, raw, schema));
  const shown = lines.slice(0, MAX_LISTED_PROBLEMS);
  const rest = lines.length - shown.length;
  const header = `${file} is not valid (${CONFIG_INVALID_CODE}). ${lines.length} problem${
    lines.length === 1 ? '' : 's'
  }:`;
  const body = shown.map((line) => `  - ${line}`);
  if (rest > 0) body.push(`  ... and ${rest} more`);
  return [header, ...body].join('\n');
}
