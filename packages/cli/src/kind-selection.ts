/**
 * Which generator kinds a run was asked for: `--only`, and the `--pipeline` spelling it replaces.
 *
 * There were three vocabularies for one idea. A config says `orpc`, a command was called
 * `generate:orpc`, and a watch flag said `generate-orpc`, and the third one covered seven of the
 * fourteen kinds: `--pipeline generate-zod` matched no branch, so the watcher started, reported
 * nothing wrong, and regenerated nothing for as long as it ran. That is the defect this file was
 * written against, and `packages/cli/test/kind-selection.spec.ts` and the watch end-to-end spec
 * both fire on it.
 *
 * `--only` is the surviving spelling and takes the config's own words, so there is one vocabulary
 * left. `--pipeline` keeps working as an alias, because it is on published command lines, and it
 * now reaches every kind rather than half of them.
 *
 * The valid values come from `GeneratorKindSchema`, which is the enum the config parser and the
 * published JSON Schema are both built from. A kind added there is accepted here on the same
 * commit, and a value that is not one of them is refused by name rather than matching nothing.
 */
import { GENERATOR_KINDS, type GeneratorKind } from './config.js';

/** The prefix `--pipeline` puts in front of a kind. */
const PIPELINE_PREFIX = 'generate-';

/** A `--only` or `--pipeline` value the CLI will not guess at. Carries its own message. */
export class KindSelectionError extends Error {
  constructor(
    /** The code the `--json` failure document reports. */
    readonly code: string,
    message: string,
    /** The line printed under the error, when there is a way out worth naming. */
    readonly hint?: string
  ) {
    super(message);
    this.name = 'KindSelectionError';
  }
}

/** Every kind, as one comma-separated list, for a message that has to show what is allowed. */
export function kindList(): string {
  return GENERATOR_KINDS.join(', ');
}

function isKind(value: string): value is GeneratorKind {
  return (GENERATOR_KINDS as readonly string[]).includes(value);
}

/**
 * The kinds `--only <list>` names, or `undefined` when the flag was not passed.
 *
 * An empty set is never returned: a flag that was passed and selected nothing is a mistake worth
 * a message, not a run that quietly does nothing.
 */
export function parseOnly(value: unknown, flag = '--only'): Set<GeneratorKind> | undefined {
  if (value === undefined || value === null) return undefined;
  const requested = String(value)
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (!requested.length) {
    throw new KindSelectionError(
      'DRZL_CLI_ONLY',
      `${flag} was given no kind. Pass one or more of: ${kindList()}.`
    );
  }
  const kinds = new Set<GeneratorKind>();
  for (const name of requested) {
    if (isKind(name)) {
      kinds.add(name);
      continue;
    }
    // The `generate-orpc` spelling is what `--pipeline` takes and what a reader coming from it
    // will type first, so it is named rather than listed among fourteen alternatives.
    const bare = name.startsWith(PIPELINE_PREFIX) ? name.slice(PIPELINE_PREFIX.length) : '';
    throw new KindSelectionError(
      'DRZL_CLI_ONLY',
      `${flag}: there is no generator kind "${name}".`,
      isKind(bare)
        ? `Write it the way the config does: ${flag} ${bare}.`
        : `Valid kinds are: ${kindList()}.`
    );
  }
  return kinds;
}

/** What `watch` was asked to do, once `--pipeline` and `--only` have both been read. */
export interface WatchSelection {
  /** `--pipeline analyze`: report the analysis and run no generator. */
  analyzeOnly: boolean;
  /** The kinds to run, or `undefined` for every kind the config names. */
  kinds?: Set<GeneratorKind>;
}

/**
 * Read `--pipeline` and `--only` together.
 *
 * `--pipeline analyze` keeps the meaning it has always had. `--pipeline all` is the default and
 * selects nothing, which is how "every generator in the config" is spelled. Anything else is
 * `generate-<kind>`, which is `--only <kind>` written the old way.
 *
 * Passing both a narrowing `--pipeline` and `--only` is refused rather than resolved. Any rule for
 * combining them, intersection or last-wins, is one a reader would have to look up, and the two
 * flags mean the same thing.
 */
export function resolveWatchSelection(opts: {
  pipeline?: unknown;
  only?: unknown;
}): WatchSelection {
  const only = parseOnly(opts.only);
  const pipeline =
    opts.pipeline === undefined || opts.pipeline === null ? 'all' : String(opts.pipeline);

  if (pipeline === 'analyze') {
    if (only) {
      throw new KindSelectionError(
        'DRZL_CLI_ONLY',
        '--pipeline analyze runs no generator, so it cannot be combined with --only.',
        'Drop one of the two.'
      );
    }
    return { analyzeOnly: true };
  }

  if (pipeline === 'all') return { analyzeOnly: false, kinds: only };

  if (only) {
    throw new KindSelectionError(
      'DRZL_CLI_ONLY',
      '--pipeline and --only say the same thing, so passing both is ambiguous.',
      `Use --only ${[...only].join(',')} on its own; --pipeline is the older spelling.`
    );
  }

  const bare = pipeline.startsWith(PIPELINE_PREFIX) ? pipeline.slice(PIPELINE_PREFIX.length) : '';
  if (!isKind(bare)) {
    throw new KindSelectionError(
      'DRZL_CLI_ONLY',
      `--pipeline: there is no pipeline called "${pipeline}".`,
      // A bare kind is the mirror image of the mistake `parseOnly` names, and the answer is the
      // flag that takes bare kinds rather than the list of sixteen values this one takes.
      isKind(pipeline)
        ? `That is a generator kind, so it goes to the newer flag: --only ${pipeline}.`
        : `Use --only <kind>, or one of: all, analyze, ${GENERATOR_KINDS.map(
            (k) => PIPELINE_PREFIX + k
          ).join(', ')}.`
    );
  }
  return { analyzeOnly: false, kinds: new Set([bare]) };
}

/**
 * The generator entries a selection keeps, in the order the config wrote them.
 *
 * Order matters and is the config's: two entries of the same kind pointed at different paths both
 * survive, and a selection is a filter rather than a reordering.
 */
export function selectGenerators<T extends { kind: string }>(
  generators: readonly T[],
  kinds: Set<GeneratorKind> | undefined
): T[] {
  if (!kinds) return [...generators];
  return generators.filter((g) => kinds.has(g.kind as GeneratorKind));
}

/**
 * Why a selection matched nothing, as a sentence, or `undefined` when it matched something.
 *
 * A `--only` that selects no configured generator is the silent no-op this whole change exists to
 * remove, so it is reported with both halves of the mismatch: what was asked for, and what the
 * config actually names.
 */
export function emptySelectionMessage(
  kinds: Set<GeneratorKind> | undefined,
  configured: readonly { kind: string }[],
  flag = '--only'
): string | undefined {
  if (!kinds || selectGenerators(configured, kinds).length) return undefined;
  const asked = [...kinds].join(', ');
  const names = [...new Set(configured.map((g) => g.kind))];
  return (
    `${flag} ${asked} matched no generator in this config, which names: ` +
    `${names.join(', ') || 'none'}.`
  );
}
