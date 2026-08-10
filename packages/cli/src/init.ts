/**
 * `drzl init`: find the schema, ask what to generate, write a config that runs.
 *
 * Three defects were fixed here at once, and they are one command's worth of work because each
 * one is the reason the next is hard to see (plan items 65, 66, 67).
 *
 * **The schema path was invented (67).** `init` wrote `schema: 'src/db/schema.ts'` whether or
 * not that file existed. Measured on the shipped 4.22.0 CLI, in an empty directory: `init`
 * exits 0, and the `drzl generate` that follows it analyzes nothing, writes
 * `src/api/placeholder.orpc.ts` reading "No tables detected in analysis", and also exits 0. The
 * first two commands a new user runs therefore both report success having read no schema at
 * all. So detection is not a convenience here; it is what stops the product from lying on its
 * first run.
 *
 * Detection validates a candidate by loading it and counting Drizzle tables, never by
 * `existsSync`. The analyzer separates the three answers cleanly, which is what makes the rule
 * possible (measured against `@drzl/analyzer` 1.20.1):
 *
 *   - a real schema           -> `tables.length > 0`, no issues
 *   - a file that is not one  -> `tables.length === 0`, no issues, dialect 'unknown'
 *   - a file it could not run -> `tables.length === 0` plus a `DRZL_ANL_IMPORT` error issue
 *
 * The middle case is rejected and the walk continues, because a `schema.ts` that exports a
 * connection string is worse than no detection: it produces exactly the silent placeholder run
 * above. The last case is adopted with a warning rather than rejected, because "DRZL could not
 * import it" is usually "you have not run install yet", and the file is still obviously the
 * schema the user meant.
 *
 * **The default generator was a router (66).** `@drzl/generator-zod` is a hard dependency of
 * `@drzl/cli`, so it is on disk beside the CLI that scaffolds this config. That used to be the
 * whole rule, because six of the seven route generators were `optionalDependencies` an installer
 * skips when they are missing; all fourteen are hard dependencies now, so being installed no
 * longer tells one kind from another. What `INIT_GENERATOR_CHOICES` still offers is the set this
 * file knows how to write a config for, and a test asserts every entry against `package.json` so
 * a kind the CLI does not depend on cannot be added to the list.
 *
 * **`--yes` did nothing (65).** The flag was declared and the action ignored its options object,
 * so `init` and `init --yes` were byte-identical. The flag is kept and given the meaning it
 * always advertised, because the non-interactive path is the important one: `init` runs under
 * `npx`, in CI and under agents far more often than it runs under a human. Prompts are the
 * addition, and they are guarded so that they can never be the reason a pipeline stops:
 * `isInteractive` requires stdin AND stdout to be TTYs and `CI` to be unset, and no readline
 * interface is constructed otherwise.
 */
import { SchemaAnalyzer } from '@drzl/analyzer';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as readline from 'node:readline/promises';
import { CONFIG_FILE_NAMES } from './config.js';
import { resolveSchemaSource } from './drizzle-kit.js';

/** A generator `init` is willing to scaffold. */
export interface InitGeneratorChoice {
  kind: string;
  /** The npm package the kind loads, which must be a hard dependency of `@drzl/cli`. */
  packageName: string;
  label: string;
}

/**
 * What `init` offers, in the order the prompt lists it. The first entry is the default.
 *
 * Every kind here is a `dependencies` entry of `@drzl/cli`, enforced against `package.json` by
 * `init.spec.ts`, so a config this command writes never names a package the CLI does not bring
 * with it. That used to exclude eight kinds on its own, when they were `optionalDependencies` an
 * installer skips; every kind clears it now, and it stays as the floor rather than as the filter.
 *
 * What the list is short for is this file: `generatorLine` writes two shapes, an oRPC entry and a
 * validator entry with a `path`, and `ROUTER_KINDS` is the one kind the scaffold adds an `outDir`
 * for. The six other route generators each resolve their output directory their own way
 * (`trpcOutDir`, `honoOutDir` and the rest in `config.ts`), and none of those rules is written
 * here. Offering them would scaffold a config this command does not know the shape of, which is a
 * different job from installing one.
 */
export const INIT_GENERATOR_CHOICES: readonly InitGeneratorChoice[] = [
  { kind: 'zod', packageName: '@drzl/generator-zod', label: 'Zod validators' },
  { kind: 'valibot', packageName: '@drzl/generator-valibot', label: 'Valibot validators' },
  { kind: 'arktype', packageName: '@drzl/generator-arktype', label: 'ArkType validators' },
  { kind: 'typebox', packageName: '@drzl/generator-typebox', label: 'TypeBox validators' },
  { kind: 'orpc', packageName: '@drzl/generator-orpc', label: 'oRPC router' },
];

/** The kind chosen when nothing says otherwise: `--yes`, a non-TTY, or an empty prompt answer. */
export const DEFAULT_GENERATOR_KIND = INIT_GENERATOR_CHOICES[0].kind;

/** The kinds that write routers, and so need an `outDir` in the scaffold. */
const ROUTER_KINDS = new Set(['orpc']);

/**
 * Where a Drizzle schema conventionally lives, most specific first, as stems without an
 * extension.
 *
 * Not invented. `src/db/schema.ts` and `src/db/schemas/index.ts` are the two paths this
 * repository's own docs use (34 and 8 occurrences across `docs/`, the READMEs and `examples/`),
 * and the rest are the same two shapes under the other roots frameworks put source in, plus
 * `drizzle/`, which is where a kit `out` directory conventionally sits. Being wrong about any
 * one of them costs nothing: an entry that does not exist is never opened, and an entry that
 * exists still has to declare tables before it is used.
 *
 * Every stem ends in `schema` or `schemas`, and that is a rule rather than a coincidence: a
 * candidate is validated by importing it, and importing `src/db/index.ts` on the guess that it
 * might re-export tables would just as often open a database connection. A module named for the
 * schema is one that declares rather than connects.
 */
export const SCHEMA_CANDIDATE_STEMS: readonly string[] = [
  'src/db/schema',
  'src/db/schema/index',
  'src/db/schemas/index',
  'src/lib/db/schema',
  'src/lib/db/schema/index',
  'src/schema',
  'src/schema/index',
  'src/schemas/index',
  'app/db/schema',
  'lib/db/schema',
  'db/schema',
  'db/schema/index',
  'drizzle/schema',
  'schema',
];

/** Extensions tried for each stem, in order. */
const CANDIDATE_EXTENSIONS = ['.ts', '.js'] as const;

/** Every conventional candidate path, in the order they are tried. */
export function schemaCandidates(): string[] {
  const out: string[] = [];
  for (const stem of SCHEMA_CANDIDATE_STEMS) {
    for (const ext of CANDIDATE_EXTENSIONS) out.push(`${stem}${ext}`);
  }
  return out;
}

export type CandidateVerdict =
  /** Imported, and Drizzle tables came back. */
  | 'confirmed'
  /** Present, but could not be imported at all, so it is neither proved nor disproved. */
  | 'unverified'
  /** Imported cleanly and declares no tables, so it is not a schema. */
  | 'rejected';

export interface CandidateReport {
  verdict: CandidateVerdict;
  tables: number;
  /** The import failure, when there was one. */
  reason?: string;
}

/**
 * Load a candidate and decide what it is. Never throws: an analyzer that blows up on a file is
 * itself an answer, and the caller has more candidates to try.
 */
export async function classifySchemaCandidate(target: string | string[]): Promise<CandidateReport> {
  let analysis: Awaited<ReturnType<SchemaAnalyzer['analyze']>>;
  try {
    // Relations and constraint validation are both off. Neither changes whether a table exists,
    // and both cost time on a file that is about to be thrown away.
    analysis = await new SchemaAnalyzer(target).analyze({
      includeRelations: false,
      validateConstraints: false,
    });
  } catch (e: any) {
    return { verdict: 'unverified', tables: 0, reason: firstLine(String(e?.message ?? e)) };
  }
  if (analysis.tables.length > 0) {
    return { verdict: 'confirmed', tables: analysis.tables.length };
  }
  const importError = analysis.issues.find(
    (i) => i.level === 'error' && i.code === 'DRZL_ANL_IMPORT'
  );
  if (importError)
    return { verdict: 'unverified', tables: 0, reason: firstLine(importError.message) };
  return { verdict: 'rejected', tables: 0 };
}

/**
 * The first line of a message, for a reason printed inline. A module resolution failure carries
 * its whole "Require stack" behind the first newline, and pasting that into the middle of a
 * sentence buries the sentence.
 */
function firstLine(message: string): string {
  return String(message).split('\n')[0].trim();
}

export interface SchemaDetection {
  source: 'drizzle-kit' | 'convention' | 'none';
  /**
   * The relative path to write as `schema`, or undefined when the config should state none: a
   * drizzle-kit project states it once in its own config, and a project with no schema at all
   * must not be handed a path that is not there.
   */
  schema?: string;
  /** The drizzle-kit config consulted, when one answered. */
  drizzleKitConfig?: string;
  verdict?: CandidateVerdict;
  tables: number;
  /** Lines worth printing: what was found, or what was looked for and rejected. */
  notes: string[];
}

/**
 * Decide where the schema is, drizzle-kit first.
 *
 * The kit config is asked first because it is the only source that is a statement of fact
 * rather than a guess: the user wrote the path there themselves. `resolveSchemaSource` is the
 * whole of item 59's walk (candidate order, jiti load, glob expansion, kit's own one-level
 * directory expansion), so `init` and `generate` can never disagree about what that config
 * says.
 */
export async function detectSchema(cwd: string): Promise<SchemaDetection> {
  const notes: string[] = [];

  let kitFiles: string[] | null = null;
  let kitPath: string | undefined;
  try {
    // No `schema` and no `drizzleKit` key: exactly the shape that makes `resolveSchemaSource`
    // walk drizzle-kit's own default candidates. It throws when there is no kit config, which
    // is the common case and not an error here.
    const source = await resolveSchemaSource({}, cwd);
    if (source.source === 'drizzle-kit') {
      kitFiles = source.schema as string[];
      kitPath = source.drizzleKitConfigPath;
    }
  } catch {
    kitFiles = null;
  }

  if (kitFiles && kitPath) {
    const rel = path.relative(cwd, kitPath) || path.basename(kitPath);
    const report = await classifySchemaCandidate(kitFiles);
    if (report.verdict === 'confirmed' || report.verdict === 'unverified') {
      notes.push(
        report.verdict === 'confirmed'
          ? `Schema from ${rel} (${kitFiles.length} file${kitFiles.length === 1 ? '' : 's'}, ` +
              `${report.tables} table${report.tables === 1 ? '' : 's'})`
          : `Schema from ${rel}, which DRZL could not import yet: ${report.reason}`
      );
      return {
        source: 'drizzle-kit',
        drizzleKitConfig: rel,
        verdict: report.verdict,
        tables: report.tables,
        notes,
      };
    }
    notes.push(`${rel} names schema files that declare no Drizzle tables; looking elsewhere.`);
  }

  // Confirmed wins outright: the walk returns on the first confirmed candidate and only
  // collects the unverified ones, so a real schema further down the list beats a file near the
  // top that DRZL could not import. Within one verdict the convention order decides.
  const present = schemaCandidates().filter((c) => fs.existsSync(path.resolve(cwd, c)));
  const unverified: Array<{ file: string; report: CandidateReport }> = [];
  for (const file of present) {
    const report = await classifySchemaCandidate(path.resolve(cwd, file));
    if (report.verdict === 'confirmed') {
      notes.push(
        `Schema found at ${file} (${report.tables} table${report.tables === 1 ? '' : 's'})`
      );
      return {
        source: 'convention',
        schema: file,
        verdict: 'confirmed',
        tables: report.tables,
        notes,
      };
    }
    if (report.verdict === 'unverified') unverified.push({ file, report });
    else notes.push(`${file} exists but declares no Drizzle tables; not using it.`);
  }
  if (unverified.length) {
    const { file, report } = unverified[0];
    notes.push(`Schema assumed to be ${file}; DRZL could not import it: ${report.reason}`);
    return { source: 'convention', schema: file, verdict: 'unverified', tables: 0, notes };
  }

  notes.push(
    present.length
      ? 'No file DRZL looked at declares any Drizzle tables.'
      : 'No drizzle-kit config and no schema in the usual locations.'
  );
  return { source: 'none', tables: 0, notes };
}

export interface InitPlan {
  /** What to write as `schema`, or undefined to write none. */
  schema?: string;
  schemaSource: SchemaDetection['source'];
  /** Deduplicated, in `INIT_GENERATOR_CHOICES` order. */
  generators: string[];
}

/** The `generators` entry each kind scaffolds as. */
function generatorLine(kind: string): string {
  if (kind === 'orpc') return `{ kind: 'orpc', template: 'standard', includeRelations: true }`;
  return `{ kind: '${kind}', path: 'src/validators/${kind}' }`;
}

/**
 * The config file text.
 *
 * `import type` plus `satisfies`, never `defineConfig`. The scaffold has to keep working under
 * `npx @drzl/cli init` in a project with no local `@drzl/cli` to resolve, and a type-only import
 * is erased before jiti ever executes the module. A value import would make the very first
 * `drzl generate` fail on a module that is not installed, and the annotation is what gives the
 * first config anyone sees editor completion.
 */
export function renderInitConfig(plan: InitPlan): string {
  const lines: string[] = [];
  lines.push(`import type { DrzlConfigInput } from '@drzl/cli/config';`);
  lines.push('');
  lines.push('export default {');

  if (plan.schema) {
    lines.push(`  schema: '${plan.schema}',`);
  } else if (plan.schemaSource === 'drizzle-kit') {
    lines.push(`  // No "schema" here on purpose: DRZL reads it from your drizzle-kit config, so`);
    lines.push(
      `  // the path is written once. Set "schema" to override it, or "drizzleKit": false`
    );
    lines.push(`  // to refuse the fallback.`);
  } else {
    lines.push(`  // Set this to your Drizzle schema file, for example 'src/db/schema.ts'. DRZL`);
    lines.push(`  // found no drizzle-kit config and no schema declaring tables in the usual`);
    lines.push(`  // locations, and will not name a file that is not there.`);
    lines.push(`  // schema: 'src/db/schema.ts',`);
  }

  const hasRouter = plan.generators.some((k) => ROUTER_KINDS.has(k));
  if (hasRouter) lines.push(`  outDir: 'src/api',`);
  lines.push(`  analyzer: { includeRelations: true, validateConstraints: true },`);
  lines.push('  generators: [');
  const others = INIT_GENERATOR_CHOICES.filter((c) => !plan.generators.includes(c.kind))
    .map((c) => `'${c.kind}'`)
    .join(', ');
  if (others) lines.push(`    // Other kinds this CLI already has installed: ${others}.`);
  // Only where it can bite. Two router generators default to the same `outDir` and would each
  // write an `index.ts` into it, so the second silently overwrites the first; a config with no
  // router in it cannot reach that, and the line is noise there.
  if (hasRouter) {
    lines.push('    // A second router generator needs its own "path"; they share "outDir".');
  }
  // Trailing commas and a closing semicolon. Without them Prettier rewrites the scaffold the
  // first time a project formats anything, putting a diff on a file nobody edited. Measured:
  // `prettier --single-quote --check` on the emitted config passes, and the only thing Prettier
  // still changes under its own defaults is the quote style, which no scaffold can satisfy both
  // ways at once.
  for (const kind of plan.generators) lines.push(`    ${generatorLine(kind)},`);
  lines.push('  ],');
  lines.push('} satisfies DrzlConfigInput;');
  return lines.join('\n') + '\n';
}

/**
 * Whether to ask anything at all.
 *
 * Both streams, not just stdin. A question printed down a redirected stdout is invisible, so
 * waiting for its answer is a hang from the only point of view that matters. `CI` is checked
 * too because some runners do allocate a pty, and a hung `init` in a pipeline is a worse defect
 * than the one prompts were added to fix.
 */
export function isInteractive(ctx: {
  stdin: { isTTY?: boolean };
  stdout: { isTTY?: boolean };
  env: Record<string, string | undefined>;
}): boolean {
  if (ctx.env.CI) return false;
  return Boolean(ctx.stdin.isTTY) && Boolean(ctx.stdout.isTTY);
}

/**
 * One question. `null` means there are no more answers coming, from any cause: the stream
 * closed, or the user pressed Ctrl+D, which readline in TTY mode reports by rejecting with an
 * AbortError rather than by closing. Callers take their default and stop asking.
 */
async function ask(rl: readline.Interface, question: string): Promise<string | null> {
  const closed = new Promise<null>((resolve) => rl.once('close', () => resolve(null)));
  try {
    return await Promise.race([rl.question(question), closed]);
  } catch {
    return null;
  }
}

export interface PromptResult extends InitPlan {
  /** True when input ran out and the remaining questions took their defaults. */
  endedEarly: boolean;
}

/**
 * Ask what the flags did not already answer.
 *
 * The streams are parameters rather than `process.stdin`/`process.stdout` so the prompt logic is
 * driven by a test on ordinary pipes. Deciding *whether* to call this is `isInteractive`'s job,
 * and it is the only thing that reads `isTTY`.
 */
export async function promptForPlan(args: {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  detection: SchemaDetection;
  cwd: string;
  schemaFromFlag?: string;
  generatorsFromFlag?: string[];
}): Promise<PromptResult> {
  const { input, output, detection, cwd } = args;
  const write = (s: string) => output.write(s + '\n');

  let schema = args.schemaFromFlag ?? detection.schema;
  let schemaSource: SchemaDetection['source'] = args.schemaFromFlag
    ? 'convention'
    : detection.source;
  let generators = args.generatorsFromFlag;
  let endedEarly = false;

  // Loaded here rather than at the top of the module, so a runtime whose `node:readline/promises`
  // is missing or partial cannot break the non-interactive path, which is the one that runs under
  // `npx`, in CI and under Bun and Deno. If it cannot be loaded at all, the defaults are taken
  // and nothing is asked: a command that degrades to `--yes` is a nuisance, and one that throws
  // where it used to write a config is a regression.
  let readlineModule: typeof readline;
  try {
    readlineModule = await import('node:readline/promises');
  } catch {
    return {
      schema,
      schemaSource,
      generators: normalizeGenerators(generators) ?? [DEFAULT_GENERATOR_KIND],
      endedEarly: true,
    };
  }
  const rl = readlineModule.createInterface({ input, output });
  try {
    if (args.schemaFromFlag === undefined) {
      for (const note of detection.notes) write(note);
      const prompt =
        detection.source === 'drizzle-kit'
          ? 'Schema file, or Enter to keep reading it from your drizzle-kit config: '
          : detection.schema
            ? `Schema file [${detection.schema}]: `
            : 'Schema file (Enter to leave it unset): ';
      const answer = await ask(rl, prompt);
      if (answer === null) endedEarly = true;
      else if (answer.trim()) {
        const typed = answer.trim();
        const report = await classifySchemaCandidate(path.resolve(cwd, typed));
        if (report.verdict === 'confirmed') {
          write(`  ${typed}: ${report.tables} table${report.tables === 1 ? '' : 's'}`);
        } else if (report.verdict === 'unverified') {
          write(`  ${typed}: DRZL could not import it (${report.reason}). Using it anyway.`);
        } else {
          write(`  ${typed}: no Drizzle tables found in it. Using it anyway.`);
        }
        schema = typed;
        schemaSource = 'convention';
      }
    }

    if (generators === undefined && !endedEarly) {
      write('What should DRZL generate?');
      INIT_GENERATOR_CHOICES.forEach((c, i) => write(`  ${i + 1}) ${c.label}`));
      // Bounded, so a stream of nonsense cannot keep this open. Every exit from the loop either
      // has an answer or falls through to the default.
      for (let attempt = 0; attempt < 3; attempt++) {
        const answer = await ask(rl, `Choice [1, ${INIT_GENERATOR_CHOICES[0].label}]: `);
        if (answer === null) {
          endedEarly = true;
          break;
        }
        const raw = answer.trim().toLowerCase();
        if (!raw) break;
        const byIndex = Number(raw);
        const picked =
          Number.isInteger(byIndex) && byIndex >= 1 && byIndex <= INIT_GENERATOR_CHOICES.length
            ? INIT_GENERATOR_CHOICES[byIndex - 1]
            : INIT_GENERATOR_CHOICES.find((c) => c.kind === raw);
        if (picked) {
          generators = [picked.kind];
          break;
        }
        write(`  "${answer.trim()}" is not one of the choices.`);
      }
    }
  } finally {
    rl.close();
  }

  return {
    schema,
    schemaSource,
    generators: normalizeGenerators(generators) ?? [DEFAULT_GENERATOR_KIND],
    endedEarly,
  };
}

/**
 * Deduplicate and order a kind list, or throw naming the offender. Returns undefined for
 * undefined so a missing flag stays a question rather than becoming an empty answer.
 */
export function normalizeGenerators(kinds: string[] | undefined): string[] | undefined {
  if (kinds === undefined) return undefined;
  const known = new Set(INIT_GENERATOR_CHOICES.map((c) => c.kind));
  for (const k of kinds) {
    if (!known.has(k)) {
      throw new Error(
        `drzl init: "${k}" is not a generator init can scaffold. Choose from ` +
          `${[...known].join(', ')}. Every other kind is installed and works; add it to ` +
          `drzl.config by hand, following the entry for it in the docs.`
      );
    }
  }
  const picked = INIT_GENERATOR_CHOICES.filter((c) => kinds.includes(c.kind)).map((c) => c.kind);
  return picked.length ? picked : undefined;
}

/** Split a `--generators zod,orpc` value. */
export function parseGeneratorsFlag(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const parts = value
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!parts.length) throw new Error('drzl init: --generators was given no kinds.');
  return parts;
}

export interface InitOutcome {
  code: number;
  /** Absolute path written, when one was. */
  written?: string;
  plan?: InitPlan;
}

/**
 * The whole command. Returns an exit code rather than calling `process.exit`, so a test can run
 * it in-process and so the caller owns the one exit in the CLI.
 */
export async function runInit(args: {
  cwd: string;
  yes?: boolean;
  schemaFlag?: string;
  generatorsFlag?: string;
  stdin: NodeJS.ReadableStream & { isTTY?: boolean };
  stdout: NodeJS.WritableStream & { isTTY?: boolean };
  env: Record<string, string | undefined>;
  log: (s: string) => void;
  error: (s: string) => void;
}): Promise<InitOutcome> {
  const target = path.resolve(args.cwd, 'drzl.config.ts');

  // Before any detection, and before any question. Everything that follows costs a jiti import
  // of the user's schema, and none of it is worth doing for a config that will not be written.
  //
  // Every config name, not just `drzl.config.ts`. `loadConfig` tries the five names in a fixed
  // order with `.ts` first, so writing a `.ts` scaffold beside an existing `drzl.config.json`
  // does not overwrite that file and does something worse: it shadows it, and the next
  // `drzl generate` silently runs the scaffold instead of the config the user wrote. Measured on
  // 4.22.0, which checked only the one name.
  const existing = CONFIG_FILE_NAMES.find((name) => fs.existsSync(path.resolve(args.cwd, name)));
  if (existing) {
    args.error(
      `drzl init: ${existing} already exists, so nothing was written. Delete it, or edit it by ` +
        `hand; init never overwrites a config, and will not write one that shadows it either.`
    );
    return { code: 1 };
  }

  let fromFlag: string[] | undefined;
  try {
    fromFlag = normalizeGenerators(parseGeneratorsFlag(args.generatorsFlag));
  } catch (e: any) {
    args.error(String(e?.message ?? e));
    return { code: 1 };
  }

  const detection = await detectSchema(args.cwd);

  let plan: InitPlan;
  const interactive =
    !args.yes && isInteractive({ stdin: args.stdin, stdout: args.stdout, env: args.env });

  if (interactive) {
    const result = await promptForPlan({
      input: args.stdin,
      output: args.stdout,
      detection,
      cwd: args.cwd,
      schemaFromFlag: args.schemaFlag,
      generatorsFromFlag: fromFlag,
    });
    plan = {
      schema: result.schema,
      schemaSource: result.schemaSource,
      generators: result.generators,
    };
  } else {
    for (const note of detection.notes) args.log(note);
    plan = {
      schema: args.schemaFlag ?? detection.schema,
      schemaSource: args.schemaFlag ? 'convention' : detection.source,
      generators: fromFlag ?? [DEFAULT_GENERATOR_KIND],
    };
    // An explicit flag is always obeyed, because a user may be scaffolding before writing the
    // schema, but it is never obeyed silently: this is the one path that can put a path DRZL
    // could not confirm into the config, and detection's whole point is that such a config runs
    // and reports success having read nothing.
    if (args.schemaFlag) {
      const full = path.resolve(args.cwd, args.schemaFlag);
      if (!fs.existsSync(full)) {
        args.log(`--schema ${args.schemaFlag} is not there yet. Writing it anyway.`);
      } else if ((await classifySchemaCandidate(full)).verdict === 'rejected') {
        args.log(`--schema ${args.schemaFlag} declares no Drizzle tables. Writing it anyway.`);
      }
    }
  }

  // `wx`, so two `init` runs racing each other cannot both believe they created the file. The
  // existsSync above is the message; this is the guarantee.
  try {
    fs.writeFileSync(target, renderInitConfig(plan), { flag: 'wx' });
  } catch (e: any) {
    if (e?.code === 'EEXIST') {
      args.error(
        `drzl init: drzl.config.ts already exists, so nothing was written. init never ` +
          `overwrites a config.`
      );
      return { code: 1 };
    }
    args.error(`drzl init: could not write ${target}: ${e?.message ?? e}`);
    return { code: 1 };
  }

  args.log(`Created ${target}`);
  args.log(`  generators: ${plan.generators.join(', ')}`);
  if (plan.schema) args.log(`  schema: ${plan.schema}`);
  else if (plan.schemaSource === 'drizzle-kit') args.log('  schema: from your drizzle-kit config');
  else
    args.log(
      '  schema: not set. Fill in "schema" before running `drzl generate`, or add a ' +
        'drizzle-kit config.'
    );
  return { code: 0, written: target, plan };
}
