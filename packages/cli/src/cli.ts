#!/usr/bin/env node
import { qualifiedTableName, SchemaAnalyzer } from '@drzl/analyzer';
import chokidar from 'chokidar';
import { Command } from 'commander';
import * as path from 'node:path';
import {
  EXIT_FAILED,
  EXIT_FINDINGS,
  EXIT_OK,
  messageOf,
  jsonFailure,
  Output,
} from './output.js';
import {
  computeGeneratorOutputDirs,
  computeWatchTargets,
  configFromKinds,
  DrzlConfig,
  filterTables,
  loadConfig,
  tableFilterWarnings,
  type GeneratorKind,
} from './config.js';
import {
  entryFor,
  GENERATOR_BY_KIND,
  resolveServicesDir,
  runGenerator,
  runGeneratorWithOptions,
} from './generator-registry.js';
import {
  emptySelectionMessage,
  KindSelectionError,
  kindList,
  parseOnly,
  resolveWatchSelection,
  selectGenerators,
  type WatchSelection,
} from './kind-selection.js';
import { ConfigValidationError } from './config-errors.js';
import {
  describeSchemaTarget,
  nothingToGenerate,
  schemaLoadFailure,
  type SchemaProblem,
} from './schema-outcome.js';
import { filterColumns } from './column-filter.js';
import {
  ambiguousTableProblem,
  explainTable,
  matchTable,
  noSuchTableProblem,
  renderExplanation,
  renderIndex,
  summarize,
  type TableMatch,
} from './explain.js';
import {
  dialectMismatchWarning,
  resolveSchemaSource,
  type ResolvedSchemaSource,
} from './drizzle-kit.js';
import { buildDoctorReport, renderDoctorReport } from './doctor.js';
import { snapshotAll } from './drift.js';
import {
  describeCounts,
  displayPath,
  driftStatusOf,
  EmitPlan,
  pendingChanges,
  verifyNothingWasWritten,
  type EmittedFile,
  type FileVerdict,
} from './emit-plan.js';
import { unifiedDiff } from './unified-diff.js';
import { createRebuildScheduler, resolveDebounce } from './watch-loop.js';
import { GeneratorNotInstalledError } from './generator-loader.js';
import { detectSchema, INIT_GENERATOR_CHOICES, runInit } from './init.js';
import { maybeShowSponsorMessage } from './sponsor.js';
import { CLI_VERSION } from './version.js';

/**
 * Say what went wrong with a generator, distinguishing the two things that can.
 *
 * Every branch below used to print "<name> generator missing. Install with: npm install
 * @drzl/generator-<name>" for anything at all that threw, with the real reason on a trailing
 * "Error details" line. A generator that was installed and merely failed therefore sent its user
 * to reinstall a package they already had, and the sentence that would have told them what
 * actually happened was the one written as a footnote.
 *
 * `loadGenerator` marks the one case that is an install problem, so the package name comes off the
 * error rather than being repeated here beside the `import()` that already spells it.
 */
function reportGeneratorFailure(out: Output, kind: string, e: unknown): string {
  if (e instanceof GeneratorNotInstalledError) {
    out.error(`The ${kind} generator is not installed.`);
    out.hint(`Install with: npm install ${e.specifier}`);
    return `The ${kind} generator is not installed. Install with: npm install ${e.specifier}`;
  }
  const detail = messageOf(e);
  out.error(`The ${kind} generator failed:`, detail);
  return `The ${kind} generator failed: ${detail}`;
}

/**
 * The output layer for one command invocation.
 *
 * Built per run rather than as a module singleton, so `--quiet` and `--json` are answered once and
 * every writer downstream shares that answer. See `output.ts` for the stream and colour rules.
 */
function outputFor(opts: { quiet?: boolean; json?: boolean }): Output {
  return new Output({ quiet: !!opts.quiet, json: !!opts.json });
}

/**
 * The code a thrown value reports, when it is one of ours.
 *
 * `instanceof`, rather than reading `e.code`, because that property is Node's own convention:
 * `ENOENT` off a failed `readFile` would otherwise be published in the `--json` document as
 * though it were a DRZL identifier.
 */
function drzlErrorCode(error: unknown, fallback: string): string {
  return error instanceof ConfigValidationError ? error.code : fallback;
}

/**
 * A run that has nothing to generate from, reported and stopped (items 70 and 71).
 *
 * `EXIT_FAILED`, not `EXIT_FINDINGS`: an empty schema is not something the command was asked to
 * look for, it is the command being unable to do the work. The hint is a hint, so `--quiet` drops
 * it and the failure itself survives, which is the rule every other error here follows.
 */
function reportSchemaProblem(out: Output, command: string, problem: SchemaProblem): never {
  if (out.json) out.jsonData(jsonFailure(command, problem.code, problem.message));
  else {
    out.error(problem.message);
    out.hint(problem.hint);
  }
  process.exit(EXIT_FAILED);
}

/**
 * How many drifted files `--check` prints a diff for.
 *
 * A cap rather than no cap, because the case that produces the most drift is the one where a diff
 * helps least: a bumped generator version rewrites the header of every file, and a CI log holding
 * eight hundred near-identical hunks is a log nobody opens. Twenty is enough to read.
 *
 * The number of files beyond it is always stated, and every file is still named in the list above
 * the diffs, so nothing is hidden: what is capped is the explanation, never the finding.
 */
const DIFF_FILE_CAP = 20;

/**
 * Show what changed in each drifted file (item 81).
 *
 * On stderr, with the rest of the narration, for the reason `--check`'s file list is: the diff is
 * a report about the work rather than the work, and `drzl generate --check > out.txt` should not
 * put a patch in the file. `--quiet` drops these and keeps the list, which is the finding.
 */
function printCheckDiffs(out: Output, drift: EmittedFile[]): void {
  const shown = drift.slice(0, DIFF_FILE_CAP);
  for (const d of shown) {
    const label = displayPath(d.file);
    const text = unifiedDiff(d.before ?? '', d.after, {
      fromLabel: `a/${label}`,
      toLabel: `b/${label}`,
    });
    if (!text) continue;
    out.note('');
    for (const line of text.split('\n')) {
      if (!line) continue;
      // Coloured per line rather than per hunk, so a redirected stream gets the same text with no
      // escapes at all; `errStyle` has already answered that question for this stream.
      if (line.startsWith('+++') || line.startsWith('---')) out.note(out.errStyle.bold(line));
      else if (line.startsWith('@@')) out.note(out.errStyle.cyan(line));
      else if (line.startsWith('+')) out.note(out.errStyle.green(line));
      else if (line.startsWith('-')) out.note(out.errStyle.red(line));
      else out.note(out.errStyle.gray(line));
    }
  }
  if (drift.length > shown.length) {
    out.note('');
    out.note(
      out.errStyle.gray(
        `${drift.length - shown.length} more file(s) differ. Diffs are capped at ` +
          `${DIFF_FILE_CAP} files; every drifted file is named in the list above.`
      )
    );
  }
}

/**
 * The two flags every command carries, declared once so none of them can be the one that forgets.
 *
 * Item 73 was that `--json` existed on three commands out of seven and `--quiet` on none, which
 * makes both unusable from a script: a caller cannot write `drzl <anything> --json` and know it
 * will work.
 */
function withOutputFlags(command: Command): Command {
  return command
    .option('--json', 'write one JSON document to stdout and nothing else', false)
    .option('-q, --quiet', 'drop the progress narration on stderr; errors still print', false);
}

const program = new Command();
program.name('drzl').description('DRZL - Drizzle Developer Toolkit').version(CLI_VERSION);
program.addHelpText(
  'afterAll',
  `\nNeed a template, adapter, or generator DRZL doesn't ship yet?\n→ DM @omardulaimidev on X: https://x.com/omardulaimidev\n`
);

withOutputFlags(
  program
    .command('analyze')
    .argument('<schema>', 'path to drizzle schema (TS)')
    .option('--relations', 'include relations', true)
    .option('--validate', 'validate constraints', true)
    .option('--out <file>', 'write analysis JSON to file')
).action(async (schema: string, opts: any) => {
  const out = outputFor(opts);
  try {
    const analyzer = new SchemaAnalyzer(schema);
    const spinner = out.spinner('Analyzing schema...');
    const start = Date.now();
    const res = await analyzer.analyze({
      includeRelations: !!opts.relations,
      validateConstraints: !!opts.validate,
    });
    const ms = Date.now() - start;

    // A schema the analyzer could not open or could not import comes back as an error-level issue
    // rather than as a throw, and the analysis it returns is empty. That is a run that could not
    // happen, so it is EXIT_FAILED. Every other error-level issue describes a schema that *was*
    // read and has something wrong in it, which is the EXIT_FINDINGS case: `analyze` printed a
    // usable document and is telling the caller to look at it.
    const unreadable = res.issues.some(
      (i) => i.level === 'error' && (i.code === 'DRZL_ANL_NOFILE' || i.code === 'DRZL_ANL_IMPORT')
    );
    const errors = res.issues.some((i) => i.level === 'error');
    const code = unreadable ? EXIT_FAILED : errors ? EXIT_FINDINGS : EXIT_OK;

    if (opts.out && !opts.json) {
      const fs = await import('node:fs/promises');
      // The bare `Analysis`, because that is what the option says it writes. The envelope belongs
      // to a command's answer on stdout, not to a file of analysis someone asked to keep.
      await fs.writeFile(opts.out, JSON.stringify(res, null, 2), 'utf8');
      spinner.succeed(`Analysis written to ${opts.out} in ${ms}ms`);
    } else {
      spinner.succeed(`Analyzed in ${ms}ms`);
      // The analysis's own keys at the top level, so every existing reader of `.issues`, `.tables`
      // and `.dialect` keeps working, with the envelope merged in beside them. No `ok` here, for
      // the reason spelled out on `doctor` below: on a report command that name already belongs to
      // a statement about the schema, and the run's answer is `exitCode`.
      // Indented, because `verify-packed.sh` redirects this to a file and a person reads it.
      const document = opts.json ? { command: 'analyze', exitCode: code, ...res } : res;
      out.data(JSON.stringify(document, null, 2));
    }
    process.exit(code);
  } catch (e: any) {
    const msg = messageOf(e);
    if (opts.json) out.jsonData(jsonFailure('analyze', 'DRZL_CLI_ANALYZE', msg));
    else {
      out.error('Analyze failed (DRZL_CLI_ANALYZE):', msg);
      out.hint('Tip: run with --json for structured output.');
    }
    process.exit(EXIT_FAILED);
  }
});

withOutputFlags(
  program
    .command('doctor')
    .description('Report what DRZL cannot type or enforce in your schema, and why')
    .argument('[schema]', 'path to drizzle schema (TS); defaults to the schema in drzl.config')
    .option('-c, --config <path>', 'path to drzl.config, read when no schema argument is given')
    .option('--strict', 'exit 2 when anything is reported', false)
).action(async (schema: string | undefined, opts: any) => {
  const out = outputFor(opts);
  {
    try {
      // A schema path argument, like `analyze`, or the one already named in the config, since a
      // user who has a config should not have to retype the path they put in it. Resolution
      // goes through the same `resolveSchemaSource` as `generate`, so a config whose schema
      // comes from drizzle-kit's config gets a doctor report too; its failure messages name
      // both files, which is strictly more useful than the generic line below.
      let target: string | string[] | undefined = schema;
      if (!target) {
        const cfg = await loadConfig(opts.config, (w) => out.warn(w));
        if (cfg) target = (await resolveSchemaSource(cfg)).schema;
      }
      if (!target) {
        const msg = 'No schema given. Pass a path, or run from a directory with a drzl.config.';
        if (opts.json) out.jsonData(jsonFailure('doctor', 'DRZL_CLI_DOCTOR', msg));
        else out.error('Doctor failed (DRZL_CLI_DOCTOR):', msg);
        process.exit(EXIT_FAILED);
        return;
      }

      const analyzer = new SchemaAnalyzer(target);
      // Both on, unconditionally. Doctor's job is to look at everything, and a warning that only
      // appears when relations are read would be hidden by a flag turning them off.
      const analysis = await analyzer.analyze({
        includeRelations: true,
        validateConstraints: true,
      });
      const report = buildDoctorReport(
        analysis,
        Array.isArray(target) ? target.join(', ') : target
      );

      // An error-level finding means the schema was never read: the file is missing, or importing
      // it threw. There is no report to act on, so that exits like `analyze`'s failure path rather
      // than pretending the empty analysis was a clean bill of health.
      //
      // Zero otherwise, and that is the whole point. A schema carrying a customType or a CHECK
      // this parser will not guess at is normal and usable, and a doctor that failed every
      // pipeline reading one would be switched off within a week. `--strict` is the opt-in.
      const unreadable = report.findings.some((f) => f.level === 'error');
      const code = unreadable
        ? EXIT_FAILED
        : opts.strict && report.findings.length
          ? EXIT_FINDINGS
          : EXIT_OK;

      // The report's own keys at the top level, so every reader of `.findings` and `.counts`
      // keeps working, with the envelope's three keys merged in beside them. `ok` is about
      // whether DRZL could run, not about whether the schema is clean: a report full of findings
      // is a successful doctor run, which is why it is `!unreadable` rather than `report.ok`.
      // `command` and `exitCode` first, the report's own keys after, and the order matters: this
      // report has published an `ok` of its own since it shipped, and it means "nothing to report
      // about the schema", which is not the same question as "could DRZL run". The report's
      // meaning is the one that survives, and the run's answer is `exitCode`. That is also why the
      // envelope defines no `ok` for the two report commands; see docs/cli/output.md.
      if (opts.json)
        out.data(JSON.stringify({ command: 'doctor', exitCode: code, ...report }, null, 2));
      else out.data(renderDoctorReport(report, out.outStyle));

      process.exit(code);
    } catch (e: any) {
      const msg = messageOf(e);
      const code = drzlErrorCode(e, 'DRZL_CLI_DOCTOR');
      if (opts.json) out.jsonData(jsonFailure('doctor', code, msg));
      else if (e instanceof ConfigValidationError) {
        // Already a report naming each key, so it prints as it is. See the same branch in
        // `generate` for why a second header over it would say less.
        out.error(msg);
      } else {
        out.error('Doctor failed (DRZL_CLI_DOCTOR):', msg);
        out.hint('Tip: run with --json for structured output.');
      }
      process.exit(EXIT_FAILED);
    }
  }
});

/**
 * Where `drzl explain` reads the schema from, in the order the answers are trustworthy.
 *
 * `--schema` is what the caller said, so it wins outright. Then the config, through the same
 * `resolveSchemaSource` every other command uses, so a drizzle-kit project needs no drzl config at
 * all. Then item 66's loading-based detection, which is what makes `drzl explain users` work in a
 * fresh checkout with nothing configured: a candidate is confirmed by importing it and finding
 * Drizzle tables, not by its name.
 *
 * Never throws for want of a config. A diagnostic command that refuses to run until you have
 * configured it is the one that gets reached for last.
 */
async function explainSchemaSource(
  opts: { schema?: string; config?: string },
  out: Output
): Promise<
  | { schema: string | string[]; label: string; note?: string; config?: DrzlConfig }
  | undefined
> {
  // An explicit `--schema` reads no config at all, and so applies no filters. The flag says "look
  // at this file", and narrowing it by a config that was written about a different one would
  // report columns as removed that nothing removed.
  if (opts.schema) return { schema: opts.schema, label: opts.schema };

  const cfg = await loadConfig(opts.config, (w) => out.warn(w));
  if (cfg) {
    const source = await resolveSchemaSource(cfg);
    for (const w of source.warnings) out.warn(w);
    return {
      schema: source.schema,
      label: describeSchemaTarget(source.schema),
      config: cfg,
      ...(source.source === 'drizzle-kit' && source.drizzleKitConfigPath
        ? { note: `Schema from ${path.relative(process.cwd(), source.drizzleKitConfigPath)}` }
        : {}),
    };
  }

  const detected = await detectSchema(process.cwd());
  if (!detected.schema) return undefined;
  return {
    schema: detected.schema,
    label: detected.schema,
    note: detected.notes[detected.notes.length - 1],
  };
}

withOutputFlags(
  program
    .command('explain')
    .description('Show what DRZL understood about one table, and what it did not')
    .argument(
      '[table]',
      'the table to explain, by database name, qualified name or export name; omit for the list'
    )
    .option('-c, --config <path>', 'path to drzl.config, read when --schema is not given')
    .option('-s, --schema <path>', 'path to the schema, overriding the config')
).action(async (tableName: string | undefined, opts: any) => {
  const out = outputFor(opts);
  /** Every failure this command has, reported the one way the output contract describes. */
  const fail = (problem: { code: string; message: string; hint: string }): never => {
    if (out.json) out.jsonData(jsonFailure('explain', problem.code, problem.message));
    else {
      out.error(problem.message);
      out.hint(problem.hint);
    }
    process.exit(EXIT_FAILED);
  };
  try {
    const source = await explainSchemaSource(opts, out);
    if (!source) {
      fail({
        code: 'DRZL_CFG_001',
        message:
          'No schema found (DRZL_CFG_001). There is no drzl.config, no drizzle-kit config, and ' +
          'no schema in the usual locations.',
        hint: 'Pass --schema <path>, or run `drzl init` to write a config.',
      });
      return;
    }
    if (source.note) out.note(out.errStyle.gray(source.note));

    const spinner = out.spinner('Reading the schema...');
    const analysis = await new SchemaAnalyzer(source.schema).analyze({
      // Both on, for the reason `doctor` turns both on: this command's job is to say everything
      // that is known, and a relation that appears only under a flag is one a reader would be
      // told is absent.
      includeRelations: true,
      validateConstraints: true,
    });
    spinner.stop();

    // The analyzer's own verdict, not a guess from an empty table list: a module that would not
    // import and a module that declares nothing are different mistakes in different files, and
    // `schema-outcome.ts` is where that distinction already lives. Nothing about the sentence is
    // reworded here beyond what did not happen, which for this command is never a file.
    const problem =
      schemaLoadFailure(analysis.issues, source.schema, 'There is nothing to explain.') ??
      nothingToGenerate({
        schema: source.schema,
        analyzed: analysis.tables,
        remaining: analysis.tables,
        consequence: 'There is nothing to explain.',
      });
    if (problem) reportSchemaProblem(out, 'explain', problem);

    const context = { schema: source.label, dialect: analysis.dialect };

    if (!tableName) {
      const tables = summarize(analysis);
      if (out.json) out.jsonData({ command: 'explain', exitCode: EXIT_OK, ...context, tables });
      else out.data(renderIndex(tables, context, out.outStyle));
      process.exit(EXIT_OK);
    }

    const match = matchTable(analysis.tables, tableName);
    if (match.kind === 'ambiguous') fail(ambiguousTableProblem(tableName, match.hits));
    if (match.kind === 'none') {
      fail(noSuchTableProblem(tableName, analysis.tables, match.suggestion));
    }

    // The filters are read but never applied to the search: a table this config excludes is
    // exactly the one whose absence from the output needs explaining, and a command that could not
    // find it would be answering "why is my table missing" with "there is no such table".
    const cfg = source.config;
    let keptTables: string[] | undefined;
    let keptColumns: string[] | undefined;
    if (cfg) {
      keptTables = filterTables(analysis.tables, cfg).map((t) => qualifiedTableName(t));
      try {
        const narrowed = filterColumns(
          [(match as Extract<TableMatch, { kind: 'found' }>).table],
          cfg.columns
        );
        keptColumns = narrowed.tables[0]?.columns.map((c) => c.name);
      } catch {
        // A `columns` rule this config cannot honour is `generate`'s error to raise, and raising it
        // here would leave a reader with no explanation at all of the table they asked about.
        keptColumns = undefined;
      }
    }

    const explanation = explainTable(
      analysis,
      match as Extract<TableMatch, { kind: 'found' }>,
      { keptTables, keptColumns }
    );
    if (out.json) {
      out.jsonData({ command: 'explain', exitCode: EXIT_OK, ...context, table: explanation });
    } else {
      out.data(renderExplanation(explanation, context, out.outStyle));
    }
    process.exit(EXIT_OK);
  } catch (e: any) {
    const msg = messageOf(e);
    const code = drzlErrorCode(e, 'DRZL_CLI_EXPLAIN');
    if (opts.json) out.jsonData(jsonFailure('explain', code, msg));
    else if (e instanceof ConfigValidationError) out.error(msg);
    else {
      out.error('Explain failed (DRZL_CLI_EXPLAIN):', msg);
      out.hint('Tip: run with --json for structured output.');
    }
    process.exit(EXIT_FAILED);
  }
});

withOutputFlags(
  program
    .command('generate')
    .description('Run configured generators (drzl.config.*)')
    .option('-c, --config <path>', 'path to drzl.config')
    .option('-s, --schema <path>', 'path to the schema, overriding the config')
    .option(
      '--only <kinds>',
      `run only these generator kinds, comma separated: ${kindList()}`
    )
    .option(
      '--check',
      'regenerate and fail if the result differs from what is on disk, without changing it'
    )
    .option('--dry-run', 'report what would be written, and write nothing', false)
).action(async (opts: any) => {
  const out = outputFor(opts);
  /**
   * Whether this run writes anything at all.
   *
   * `--check` and `--dry-run` are the same run with different reports at the end: both compute
   * every file's content, neither puts any of it on disk. `--check` then asks whether anything
   * differs and fails if it does; `--dry-run` prints what it found and succeeds either way.
   * Passing both is not an error, it is a `--check` that also says nothing was written, which is
   * already what `--check` says.
   */
  const planning = !!opts.check || !!opts.dryRun;
  /** Everything the `--json` document reports, filled in as the run makes it true. */
  const emitted: Array<{
    kind: string;
    files: string[];
    changes: Array<{ file: string; status: FileVerdict }>;
  }> = [];
  const warnings: string[] = [];
  /** A warning goes to stderr for a human and into the document for a machine, never both. */
  const warn = (text: string) => {
    warnings.push(text);
    out.warn(text);
  };
  {
    try {
      // Read before the config, so an unknown kind is refused by name before anything is loaded
      // rather than being applied to a config as a filter that matches nothing.
      const only = parseOnly(opts.only);
      // The config's own warnings go through `warn`, so they reach the `--json` document and
      // `--quiet` removes them, exactly like every other warning this command produces. They used
      // to be written with `console.warn` from inside `loadConfig`, which neither flag could see.
      let cfg = await loadConfig(opts.config, warn);
      if (!cfg && only) {
        // The config route with the config inlined, which is what replaces `generate:orpc` and
        // `generate:trpc`: `drzl generate --schema src/db/schema.ts --only orpc` is those commands
        // for all fourteen kinds, and every config feature still applies because there is a real
        // config here. `--schema` may be omitted, in which case the drizzle-kit config answers for
        // it exactly as it does for a config file with no `schema` key.
        cfg = configFromKinds([...only], opts.schema, warn);
      }
      if (!cfg) {
        const msg = 'No config found (DRZL_CFG_001). Create drzl.config.ts or pass --config.';
        // Was exit 2 until now, which the scheme reserves for a run that found something. A
        // config that is not there is a run that could not start.
        if (opts.json) out.jsonData(jsonFailure('generate', 'DRZL_CFG_001', msg));
        else {
          out.error(msg);
          // The one-command route, named here because this is where somebody who has no config
          // finds out they need one. `--only` on its own is enough to run without a file.
          out.hint('Or run one generator with no config: drzl generate --schema <path> --only <kind>.');
        }
        process.exit(EXIT_FAILED);
        return;
      }
      // `--schema` beats both the config's `schema` and the drizzle-kit fallback, which is what
      // the flag says and is how `explain -s` already behaves. `drizzleKit` is dropped with it so
      // a config that sets both does not draw the "schema wins, remove one of the two" warning
      // about a key the caller did not write.
      if (opts.schema) {
        const { drizzleKit: _fromConfig, ...rest } = cfg;
        cfg = { ...rest, schema: opts.schema };
      }
      // Refused before the schema is read, because it is a mistake in the command line rather than
      // anything about the project: the kinds are real and this config has none of them.
      const nothingSelected = emptySelectionMessage(only, cfg.generators);
      if (nothingSelected) {
        if (opts.json) out.jsonData(jsonFailure('generate', 'DRZL_CLI_ONLY', nothingSelected));
        else {
          out.error(nothingSelected);
          out.hint('Add it to "generators" in your config, or name a kind that is already there.');
        }
        process.exit(EXIT_FAILED);
        return;
      }
      // Where the schema comes from: `schema` in the drzl config, or, when that is omitted,
      // the drizzle-kit config, so a kit user never states the path twice. Resolved before the
      // spinner starts, because it throws the "neither file names a schema" error.
      const source = await resolveSchemaSource(cfg);
      for (const w of source.warnings) warn(w);
      // `typedJson`/`typedColumns` need one module to import tables from (`schemaPath` in
      // validation-options.ts). A drizzle-kit source resolved to exactly one file is that
      // module, so the option keeps working; several files have no single module, and the
      // generators already say so at their own call sites when they want types with no path.
      if (!cfg.schema && Array.isArray(source.schema) && source.schema.length === 1) {
        cfg = { ...cfg, schema: source.schema[0] };
      }
      if (source.source === 'drizzle-kit') {
        const n = (source.schema as string[]).length;
        // Narration, so stderr. It says where DRZL looked, not what it produced, and it used to
        // sit on stdout in front of the file list anyone was parsing.
        out.note(
          out.errStyle.gray(
            `Schema from ${path.relative(process.cwd(), source.drizzleKitConfigPath!)} ` +
              `(${n} file${n === 1 ? '' : 's'})`
          )
        );
      }
      const analyzer = new SchemaAnalyzer(source.schema);
      const spinner = out.spinner('Analyzing...');
      const t0 = Date.now();
      const analysis = await analyzer.analyze({
        includeRelations: cfg.analyzer.includeRelations,
        validateConstraints: cfg.analyzer.validateConstraints,
        includeHeuristicRelations: cfg.analyzer.includeHeuristicRelations,
      });
      // Item 70, and before the tick rather than after it: a module that never loaded has not
      // been analysed, and "Analysis complete" over the top of it is the green tick this item was
      // filed about. Everything below reads `analysis.tables`, which is empty here for a reason
      // that has nothing to do with the schema's contents.
      const loadFailure = schemaLoadFailure(analysis.issues, source.schema);
      if (loadFailure) {
        spinner.stop();
        reportSchemaProblem(out, 'generate', loadFailure);
      }
      // After the spinner rather than before it, because `filterColumns` throws on a config it
      // cannot honour and a thrown error under a live ora spinner prints into a line the spinner
      // then overwrites.
      spinner.succeed(`Analysis complete in ${Date.now() - t0}ms`);
      // The cross-check the interop makes possible: the drizzle-kit config states a dialect,
      // the analyzer measures one, and a contradiction usually means the schema paths or the
      // dialect line are stale. A warning rather than an error, because generation follows the
      // schema either way. After the spinner for the same overwrite reason as above.
      const dialectWarning = dialectMismatchWarning({
        configPath: source.drizzleKitConfigPath ?? '',
        declared: source.drizzleKitDialect,
        analyzed: analysis.dialect,
      });
      if (dialectWarning) warn(dialectWarning);
      // Both filters are applied before any generator sees the analysis, so every one of them
      // honours them without needing to know the options exist.
      //
      // Columns first. Both orders leave the same tables, since one narrows columns and the other
      // drops whole tables, but only this one lets a `columns` entry name a table that `exclude`
      // also removes without that reading as a typo, and a typo is refused.
      const narrowed = filterColumns(analysis.tables, cfg.columns);
      // Before the filter runs, so the tables it reports on are the ones the pattern really
      // reached rather than what survived it.
      const filterWarnings = tableFilterWarnings(narrowed.tables, cfg);
      analysis.tables = filterTables(narrowed.tables, cfg);
      for (const w of [...narrowed.warnings, ...filterWarnings]) warn(w);
      for (const w of wideColumnWarning(analysis.issues)) warn(w);
      // Item 71, after the filters so it can tell the two empty states apart, and before
      // `--check` snapshots anything so a check on a schema that produces nothing fails rather
      // than comparing an empty tree with itself and reporting it up to date.
      const empty = nothingToGenerate({
        schema: source.schema,
        analyzed: narrowed.tables,
        remaining: analysis.tables,
      });
      if (empty) reportSchemaProblem(out, 'generate', empty);
      // Where every generator writes, which is both the set `--check` and `--dry-run` have to know
      // the current contents of, and the set they have to prove they left alone afterwards.
      const outputDirs = computeGeneratorOutputDirs(cfg);
      // Read once, up front, for two jobs at the same time: it is the "what is on disk now" half
      // of every per-file verdict below, so the plan never reads a file itself, and it is the
      // baseline `verifyNothingWasWritten` compares against at the end. Only for a run that writes
      // nothing; an ordinary `generate` reads each file as it emits it, which costs one read per
      // generated file rather than one per file in the output tree.
      const existing = planning ? await snapshotAll(outputDirs) : undefined;
      /**
       * Every file this run produces, with the content already there beside it.
       *
       * Handed to each generator as `fileSink`, so the content is captured at the moment it would
       * be written rather than inferred afterwards from what landed on disk. Items 68, 80 and 81
       * all read this one object.
       */
      const plan = new EmitPlan({ write: !planning, existing });
      const total = analysis.tables.length || 1;
      // Whether this draws anything at all is `shouldShowProgress`'s decision: a terminal, no
      // `--quiet`, no `--json`, and enough tables that the bar will move (item 72).
      const progress = out.progress(total);
      /** One completed generator, reported the same way whichever branch produced it. */
      const generated = (kind: string, files: string[]) => {
        progress.stop();
        // A path the generator says it wrote that never reached the sink is a generator that
        // ignored `fileSink`, which on a user's machine means an installed generator package older
        // than this CLI. Under `--dry-run` or `--check` that is a run writing to a tree it promised
        // not to touch, so it stops here rather than reporting a plan that is not what happened.
        // `verifyNothingWasWritten` catches the same thing from the other side; this one can name
        // the generator.
        const missed = plan.unrecorded(files);
        if (missed.length && planning) {
          const message =
            `The ${kind} generator wrote ${missed.length} file(s) directly instead of reporting ` +
            `them, so this run could not be a preview. Update @drzl/generator-${kind} to a ` +
            `version that supports --dry-run. First file: ${displayPath(missed[0])}`;
          if (opts.json) out.jsonData(jsonFailure('generate', 'DRZL_GEN_003', message));
          else out.error(message);
          process.exit(EXIT_FAILED);
        }
        const verdicts = plan.verdictsFor(files).filter(Boolean) as EmittedFile[];
        // One entry per generator *entry*, keyed by nothing: a config may list two generators of
        // the same kind pointed at different paths, and a lookup by kind would report the first
        // one's verdicts twice.
        emitted.push({
          kind,
          files,
          changes: verdicts.map((v) => ({ file: v.file, status: v.verdict })),
        });
        if (opts.json) return;
        if (out.quiet) return;
        // Item 80: the count is what the run cost, the verdicts are what it did. A generator that
        // rewrote twelve identical files and one changed one used to report "13 files", which is
        // true and is not the sentence anyone was looking for.
        //
        // The verb changes with the mode, because "Generated" over a run that wrote nothing is the
        // same class of untruth as the green tick items 70 and 71 were filed about.
        out.succeed(
          out.errStyle.green(
            `${planning ? 'Would write' : 'Generated'} (${kind}): ${files.length} files`
          ) + out.errStyle.gray(` (${describeCounts(plan.counts(files))})`)
        );
        // Only the files that are not the same as before, and named relative to the working
        // directory, because this is the short list a person scans. The full absolute list is
        // still on stdout below, unchanged, for whatever is parsing it. Skipped under `--check`,
        // which prints the same files again below with their drift status and a diff each.
        for (const v of verdicts) {
          if (opts.check) break;
          if (v.verdict === 'unchanged') continue;
          const mark = v.verdict === 'created' ? '+' : '~';
          out.note('  ' + out.errStyle.cyan(mark + ' ' + displayPath(v.file)));
        }
        // stdout, and deliberately: for `generate` the list of files written is the answer, and a
        // caller without `--json` has nothing else to read. `--quiet` is what removes it. Under
        // `--dry-run` it is the list that *would* be written, which is the same answer to the same
        // question and keeps `drzl generate --dry-run > files.txt` working.
        for (const f of files) out.data('  - ' + out.outStyle.cyan(f));
      };
      /** One generator that threw. Reports it in whichever shape was asked for, then stops. */
      const failGenerator = (kind: string, e: unknown): never => {
        progress.stop();
        // Prints for a human and returns the same sentence for the document; the writers inside
        // it are already no-ops under `--json`, so neither shape can be the one that goes stale.
        const message = reportGeneratorFailure(out, kind, e);
        if (opts.json) out.jsonData(jsonFailure('generate', 'DRZL_GEN_002', message));
        process.exit(EXIT_FAILED);
      };
      // Where the service generator is actually writing, so a router template that imports
      // services spells a path that exists. The templates default it to `src/services`, and with
      // nothing passed that default was used no matter where the services really went, emitting an
      // import of a module that was never created. One function, shared with `watch`, so the two
      // commands cannot arrive at different answers.
      const servicesDir = resolveServicesDir(cfg);
      for (const g of selectGenerators(cfg.generators, only)) {
        // Per generator rather than once outside the loop. The bar used to be started before the
        // loop and stopped by whichever branch ran first, so in a config with two generators the
        // second updated a bar that was already stopped and drew nothing at all.
        progress.start();
        // The registry, not a fourteen-way `if`. The four copies of that chain are what let an
        // option reach one command and not the other; see `generator-registry.ts`.
        const entry = GENERATOR_BY_KIND.get(g.kind);
        if (!entry) continue;
        try {
          const files = await runGenerator(entry, g, cfg, {
            analysis,
            servicesDir,
            fileSink: plan,
            onProgress: ({ index }) => progress.update(index),
          });
          generated(g.kind, files);
        } catch (e: any) {
          failGenerator(g.kind, e);
        }
      }
      /**
       * The `generators` array both document shapes carry, with the verdicts merged in.
       *
       * `files` keeps its absolute paths, because that is what it has always published and a
       * script resolving them is entitled to keep working. `changes` is relative, because it is
       * new and a document naming somebody's home directory in every entry is worse to read and
       * impossible to compare across machines.
       */
      const generatorsDocument = () =>
        emitted.map((e) => ({
          kind: e.kind,
          files: e.files,
          changes: e.changes.map((c) => ({ file: displayPath(c.file), status: c.status })),
        }));

      if (planning) {
        // The claim `--dry-run` and `--check` make, checked rather than asserted. `existing` is the
        // snapshot taken before any generator ran, so anything that differs now was written by a
        // generator that ignored the sink, and it is put back before this reports.
        const wrote = await verifyNothingWasWritten(outputDirs, existing!);
        if (wrote.length) {
          const message =
            `${wrote.length} file(s) were written by a run that promised to write none, and have ` +
            `been restored. This means an installed generator package is older than this CLI. ` +
            `Update your @drzl/generator-* packages. First file: ${displayPath(wrote[0])}`;
          if (opts.json) out.jsonData(jsonFailure('generate', 'DRZL_GEN_003', message));
          else out.error(message);
          process.exit(EXIT_FAILED);
        }
      }

      if (opts.check) {
        const drift = pendingChanges(plan);
        const upToDate = drift.length === 0;
        // Drift is EXIT_FINDINGS, not EXIT_FAILED, and that is the whole reason the scheme has two
        // failure codes. The check ran perfectly: it regenerated in memory, compared, wrote
        // nothing, and is reporting what it found. A CI job that wants to show a diff acts on that
        // differently from a config it could not read, and until 4.23 both were 1.
        const code = upToDate ? EXIT_OK : EXIT_FINDINGS;

        if (opts.json) {
          out.jsonData({
            ok: true,
            command: 'generate',
            exitCode: code,
            check: {
              upToDate,
              drift: drift.map((d, i) => ({
                file: displayPath(d.file),
                status: driftStatusOf(d.verdict),
                // Item 81. Beyond the cap the entry is still here with its status, and only the
                // diff is absent, so a machine reading this never loses a file.
                diff:
                  i < DIFF_FILE_CAP
                    ? unifiedDiff(d.before ?? '', d.after, {
                        fromLabel: `a/${displayPath(d.file)}`,
                        toLabel: `b/${displayPath(d.file)}`,
                      })
                    : null,
              })),
              diffFileCap: DIFF_FILE_CAP,
            },
            generators: generatorsDocument(),
            warnings,
          });
          process.exit(code);
        }

        if (!upToDate) {
          out.error(`\nGenerated output is out of date (${drift.length} file(s)):`);
          for (const d of drift) {
            const status = driftStatusOf(d.verdict);
            const mark = status === 'added' ? '+' : '~';
            out.error(
              `  ${mark} ${out.errStyle.yellow(status.padEnd(8))} ${displayPath(d.file)}`
            );
          }
          // Item 81: the list says which files, the diff says what about them. Printed after the
          // list rather than instead of it, so a reader who only wants the names still gets them
          // on the first few lines, and `--quiet` keeps the list and drops the diffs, since the
          // list is the finding and the diff is the explanation.
          printCheckDiffs(out, drift);
          out.hint('\nRun `drzl generate` and commit the result. Nothing was written by this check.');
          process.exit(code);
        }
        out.succeed(out.errStyle.green('Generated output is up to date.'));
        process.exit(code);
      }

      if (opts.json) {
        out.jsonData({
          ok: true,
          command: 'generate',
          exitCode: EXIT_OK,
          check: null,
          dryRun: !!opts.dryRun,
          generators: generatorsDocument(),
          warnings,
        });
        return;
      }

      if (opts.dryRun) {
        // Item 68, and `EXIT_OK` on purpose. A dry run that computed its answer did what it was
        // asked; `2` is for a run that found what it was told to look for, and "this file would
        // change" is not a finding here, it is the answer. A preview of a project that has never
        // been generated would otherwise exit non-zero for being new, and the flag people reach
        // for before their first `generate` would look like a failure. `--check` is the flag whose
        // question is "is anything stale", and it still answers `2`.
        const counts = plan.counts();
        out.succeed(
          out.errStyle.green(`Dry run: ${counts.total} file(s) would be written`) +
            out.errStyle.gray(` (${describeCounts(counts)}). Nothing was written.`)
        );
        process.exit(EXIT_OK);
      }

      if (cfg.generators.length) {
        maybeShowSponsorMessage({ reason: 'generate', out });
      }
    } catch (e: any) {
      const msg = messageOf(e);
      const code = drzlErrorCode(e, 'DRZL_GEN_001');
      // A `--only` value that is not a kind is a mistake in the command line, so it is reported as
      // itself rather than under "Generate failed", whose tip points at the config file.
      if (e instanceof KindSelectionError) {
        if (opts.json) out.jsonData(jsonFailure('generate', e.code, msg));
        else {
          out.error(msg);
          if (e.hint) out.hint(e.hint);
        }
        process.exit(EXIT_FAILED);
      }
      if (opts.json) out.jsonData(jsonFailure('generate', code, msg));
      else if (e instanceof ConfigValidationError) {
        // Already a report about named keys, so it prints as it is: prefixing it with "Generate
        // failed" would put a second header over a message that has one, and the generic tip
        // below tells a reader to check the file the message is already about.
        out.error(msg);
      } else {
        out.error('Generate failed (DRZL_GEN_001):', msg);
        out.hint('Tip: check your drzl.config.ts and template path.');
      }
      process.exit(EXIT_FAILED);
    }
  }
});

/**
 * Refuse to generate from a schema that was never read, or that declares nothing.
 *
 * `generate:orpc no-such-file.ts` used to exit 0, having written a `placeholder.orpc.ts` whose
 * contents read "No tables detected in analysis". Item 67 stopped the first half of that; the
 * second half survived it, because a schema that imports cleanly and exports nothing produces the
 * identical placeholder and the identical exit 0, measured again here. Both are `EXIT_FAILED`
 * now, and neither writes a file.
 *
 * The two are told apart by `schema-outcome.ts`, which reads the analyzer's own verdict rather
 * than guessing from an empty table list.
 */
function schemaProblemFor(
  analysis: {
    issues: Array<{ level?: string; code?: string; message?: string }>;
    tables: Array<{ name: string }>;
  },
  schema: string
): SchemaProblem | undefined {
  return (
    schemaLoadFailure(analysis.issues, schema) ??
    nothingToGenerate({ schema, analyzed: analysis.tables, remaining: analysis.tables })
  );
}

/**
 * The one line a per-kind command prints before it does the work.
 *
 * `generate:orpc` shipped when oRPC was the only generator and `generate:trpc` arrived with the
 * tRPC generator; the twelve generators added since added no command, so the split is chronological
 * rather than principled. Both are also strictly less capable than the route they are being
 * replaced by: no config at all means no table or column filters, no naming, no format, no
 * `importExtension`, no shared validation, no `databaseInjection`, no drizzle-kit schema
 * resolution, and, because they bypass the write plan, no `--check`, no `--dry-run` and no drift
 * verdicts.
 *
 * Deprecated rather than deleted: they keep working, byte for byte, and 5.0 is where they go. The
 * line names the replacement command line verbatim so the fix is a copy and a paste, and it goes
 * through `Output.warn`, which means `--quiet` and `--json` both drop it. That matters more than it
 * looks: `--json` promises one document on stdout and nothing at all on stderr, so a notice written
 * to a stream directly would break the contract a script is relying on for the sake of a sentence
 * no script can read.
 *
 * Options with no flag on `generate` are named as config keys rather than silently omitted, and
 * only when the caller actually passed them, which `getOptionValueSource` answers exactly rather
 * than by comparing against a default the caller may have typed on purpose.
 */
function deprecationNotice(
  command: 'generate:orpc' | 'generate:trpc',
  kind: GeneratorKind,
  schema: string,
  cmd: Command
): string {
  const replacement = `drzl generate --schema ${schema} --only ${kind}`;
  const CONFIG_KEYS: Record<string, string> = {
    outDir: 'outDir',
    template: 'template',
    includeRelations: 'includeRelations',
    servicesDir: "the service generator's path",
  };
  const moved = Object.keys(CONFIG_KEYS).filter(
    (name) => cmd.getOptionValueSource(name) === 'cli'
  );
  const tail = moved.length
    ? ` (${moved.map((name) => CONFIG_KEYS[name]).join(', ')} ${
        moved.length === 1 ? 'moves' : 'move'
      } into drzl.config.ts)`
    : '';
  return `${command} is deprecated and will be removed in 5.0. Run this instead: ${replacement}${tail}`;
}

withOutputFlags(
  program
    .command('generate:orpc')
    .description('Deprecated. Use `drzl generate --schema <path> --only orpc`')
    .argument('<schema>', 'path to drizzle schema (TS)')
    .option('-o, --outDir <dir>', 'output directory', 'src/api')
    .option('--template <name>', 'template name', 'standard')
    .option('--includeRelations', 'include relation endpoints')
).action(async (schema: string, opts: any, cmd: Command) => {
  const out = outputFor(opts);
  out.warn(deprecationNotice('generate:orpc', 'orpc', schema, cmd));
  try {
    const analyzer = new SchemaAnalyzer(schema);
    const analysis = await analyzer.analyze({
      includeRelations: !!opts.includeRelations,
      validateConstraints: true,
    });
    const problem = schemaProblemFor(analysis, schema);
    if (problem) reportSchemaProblem(out, 'generate:orpc', problem);
    // The registry loads it and normalises what it hands back; the options are this command's own,
    // unchanged, which is what keeps its output identical to the release before this one.
    const files = await runGeneratorWithOptions(entryFor('orpc'), analysis, {
      outputDir: opts.outDir,
      template: opts.template,
      includeRelations: !!opts.includeRelations,
    });
    if (opts.json) {
      out.jsonData({
        ok: true,
        command: 'generate:orpc',
        exitCode: EXIT_OK,
        generators: [{ kind: 'orpc', files }],
      });
      return;
    }
    if (!out.quiet) {
      out.data(out.outStyle.green('Generated:') + ' ' + files.map((f) => out.outStyle.cyan(f)).join(', '));
    }
    maybeShowSponsorMessage({ reason: 'generate:orpc', out });
  } catch (e: any) {
    // An absent generator package goes through the same reporter both dispatch loops use, so it
    // names itself and the install line. This command reached the generator through a static
    // import until now, which meant an absent package took the process down before the action ran
    // at all, with a stack trace and no sentence. Everything else keeps the wording this command
    // has always printed, which covers the analyzer as much as the generator.
    let message: string;
    if (e instanceof GeneratorNotInstalledError) {
      message = reportGeneratorFailure(out, 'orpc', e);
    } else {
      message = messageOf(e);
      out.error('Generate orpc failed:', message);
    }
    if (opts.json) out.jsonData(jsonFailure('generate:orpc', 'DRZL_CLI_ORPC', message));
    process.exit(EXIT_FAILED);
  }
});

withOutputFlags(
  program
    .command('generate:trpc')
    .description('Deprecated. Use `drzl generate --schema <path> --only trpc`')
    .argument('<schema>', 'path to drizzle schema (TS)')
    .option('-o, --outDir <dir>', 'output directory', 'src/api')
    .option('--template <name>', 'standard | service', 'standard')
    .option('--includeRelations', 'include relation endpoints')
    .option('--servicesDir <dir>', 'where the service generator writes', 'src/services')
).action(async (schema: string, opts: any, cmd: Command) => {
  const out = outputFor(opts);
  out.warn(deprecationNotice('generate:trpc', 'trpc', schema, cmd));
  try {
    const analyzer = new SchemaAnalyzer(schema);
    const analysis = await analyzer.analyze({
      includeRelations: !!opts.includeRelations,
      validateConstraints: true,
    });
    const problem = schemaProblemFor(analysis, schema);
    if (problem) reportSchemaProblem(out, 'generate:trpc', problem);
    const files = await runGeneratorWithOptions(entryFor('trpc'), analysis, {
      outputDir: opts.outDir,
      template: opts.template,
      includeRelations: !!opts.includeRelations,
      // Only consulted by `--template service`, and passed unconditionally so this command
      // cannot become the branch that forgets it.
      servicesDir: opts.servicesDir,
    });
    if (opts.json) {
      out.jsonData({
        ok: true,
        command: 'generate:trpc',
        exitCode: EXIT_OK,
        generators: [{ kind: 'trpc', files }],
      });
      return;
    }
    if (!out.quiet) {
      out.data(
        out.outStyle.green('Generated:') +
          ' ' +
          files.map((f: string) => out.outStyle.cyan(f)).join(', ')
      );
    }
    maybeShowSponsorMessage({ reason: 'generate:trpc', out });
  } catch (e: any) {
    const message = reportGeneratorFailure(out, 'trpc', e);
    if (opts.json) out.jsonData(jsonFailure('generate:trpc', 'DRZL_CLI_TRPC', message));
    process.exit(EXIT_FAILED);
  }
});

program
  .command('watch')
  .description('Watch schema and regenerate on changes')
  .option('-c, --config <path>', 'path to drzl.config')
  .option(
    '--only <kinds>',
    `rebuild only these generator kinds, comma separated: ${kindList()}`
  )
  .option(
    '--pipeline <name>',
    'all | analyze | generate-<kind>, the older spelling of --only',
    'all'
  )
  .option('--debounce <ms>', 'wait this long after the last change before rebuilding', '200')
  .option('--clear', 'clear the terminal before each rebuild', false)
  .option('--json', 'emit JSON logs', false)
  .option('-q, --quiet', 'drop the progress narration on stderr; errors still print', false)
  .option('--poll', 'force polling (helps WSL/Docker/remote FS)', false)
  .action(async (opts: any) => {
    // `watch` has no answer to give: it is narration until it is stopped. So everything human it
    // prints goes to stderr, and stdout carries only the `--json` event stream, which is the one
    // thing here a program reads.
    const out = outputFor(opts);

    /**
     * Which kinds this watcher rebuilds, from `--only` or from the `--pipeline` spelling it
     * replaces.
     *
     * Read before the watcher exists, and fatal, unlike everything else this command refuses.
     * A schema that will not parse is an ordinary intermediate state and the watcher waits it out;
     * a flag value that is not a generator kind cannot become one however many times the schema is
     * saved, so reporting it and then watching would be a process that never does anything and
     * never says why. `--pipeline generate-zod` was exactly that until now: it named no branch, so
     * the watcher started, printed its watch list, and regenerated nothing for as long as it ran.
     */
    let selection: WatchSelection;
    try {
      selection = resolveWatchSelection(opts);
    } catch (e: any) {
      if (e instanceof KindSelectionError) {
        if (opts.json) out.jsonData(jsonFailure('watch', e.code, e.message));
        else {
          out.error(e.message);
          if (e.hint) out.hint(e.hint);
        }
      } else out.error(messageOf(e));
      process.exit(EXIT_FAILED);
      return;
    }

    /**
     * A schema `watch` has nothing to generate from, reported without stopping (items 70, 71).
     *
     * The one place in this change where the failure is not an exit code, and deliberately. A
     * watcher exists to be running while the schema is being edited, and the states this reports
     * are all ordinary intermediate ones: a file saved mid-expression does not parse, a file
     * being written from scratch declares no tables yet, and a table filter is usually adjusted
     * with the watcher up. Exiting on any of them would mean the user has to restart the watcher
     * to recover from a typo, which is the opposite of what the command is for. So it says what is
     * wrong, writes nothing, and waits for the next save, exactly as `run`'s own catch already
     * does for a generator that throws.
     */
    const reportWatchProblem = (problem: SchemaProblem) => {
      if (opts.json) {
        out.jsonData({ event: 'error', code: problem.code, message: problem.message });
        return;
      }
      out.error(problem.message);
      out.hint(problem.hint);
    };

    /**
     * Wipe the terminal before a rebuild, if that was asked for and there is a terminal (item 75).
     *
     * Three things were wrong with the `console.clear()` this replaces, and only the first is the
     * one the plan item names.
     *
     * It was not optional. Every rebuild wiped the screen, taking the previous rebuild's errors
     * and the startup banner listing the watched directories with it, so the answer to "what did
     * it say last time" was always "it is gone". A watcher a person leaves running all day is the
     * last place to throw away scrollback without being asked.
     *
     * It was decided from the wrong stream. `console.clear()` writes to stdout and does nothing
     * when stdout is not a terminal, but everything this command prints for a human is on stderr.
     * So `drzl watch > events.json` on a terminal left the terminal uncleared, and the stream that
     * would have been cleared was the one carrying the JSON. That is the same defect item 77 fixed
     * for colour, arrived at from the other direction.
     *
     * It also wrote the escape to a stream a program may be reading. Node happens to make that
     * harmless by checking `isTTY` first, which is why nothing leaked, but the check belonged to
     * the stream being cleared rather than to whichever one `console` was bound to.
     *
     * `2J` erases the display and `3J` the scrollback, then the cursor goes home. Sent together,
     * because erasing the display alone leaves the previous rebuild one scroll away and the point
     * of asking for this is a screen holding only the current run.
     */
    const clearScreen = () => {
      if (!opts.clear || opts.json || out.quiet) return;
      if (!out.stderr.isTTY) return;
      out.stderr.write('\u001b[2J\u001b[3J\u001b[H');
    };

    // Wrapped, unlike the reload inside `run`, which has its own catch. A config that does not
    // validate throws out of here, and with nothing around it the rejection escapes the action
    // and Node prints a stack trace over the report that names each offending key.
    let loaded: DrzlConfig | null;
    try {
      loaded = await loadConfig(opts.config, (w) => out.warn(w));
    } catch (e: any) {
      out.error(messageOf(e));
      process.exit(EXIT_FAILED);
      return;
    }
    if (!loaded) {
      out.error('No config found (DRZL_CFG_001). Create drzl.config.ts or pass --config.');
      process.exit(EXIT_FAILED);
      return;
    }
    // Through a second binding rather than narrowing the first, so `cfg` stays non-nullable for
    // the closures below: `run` and the watcher callbacks capture it, and a `let` a closure reads
    // does not keep the narrowing a guard in this scope gave it.
    let cfg: DrzlConfig = loaded;

    const abs = (p: string) => path.resolve(process.cwd(), p);
    const isInside = (child: string, parent: string) => {
      const rel = path.relative(parent, child);
      return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
    };

    // Resolved before the watcher exists, because the directories to watch depend on it: a
    // schema read from drizzle-kit's config lives wherever that config says, and a watcher
    // that does not cover those directories never fires. A resolution failure here is a
    // startup failure, exactly like a missing config; inside `run` the same failure is caught
    // and reported, so a broken edit mid-watch can be fixed by the next save.
    let source: ResolvedSchemaSource;
    try {
      source = await resolveSchemaSource(cfg);
    } catch (e: any) {
      out.error(messageOf(e));
      process.exit(EXIT_FAILED);
      return;
    }
    for (const w of source.warnings) out.warn(w);

    const ignoredOutDirs = new Set<string>(computeGeneratorOutputDirs(cfg).map(abs));
    const currentTargets = new Set<string>(
      computeWatchTargets(cfg, process.cwd(), source).map(abs)
    );

    const syncWatcherTargets = (watcher: import('chokidar').FSWatcher, next: Set<string>) => {
      const add: string[] = [];
      const del: string[] = [];
      for (const p of next) if (!currentTargets.has(p)) add.push(p);
      for (const p of currentTargets) if (!next.has(p)) del.push(p);
      if (add.length) watcher.add(add);
      if (del.length) watcher.unwatch(del);
      currentTargets.clear();
      next.forEach((p) => currentTargets.add(p));
    };

    const rebuildIgnoreDirsFrom = (cfgNow: DrzlConfig) => {
      ignoredOutDirs.clear();
      for (const d of computeGeneratorOutputDirs(cfgNow)) ignoredOutDirs.add(abs(d));
    };

    // Watch targets are directories now, because chokidar v4 dropped glob support. The
    // extensions the old `**/*.{ts,tsx,js}` glob selected therefore have to be filtered here
    // instead, or every unrelated file in the schema's directory would trigger a rebuild.
    const WATCHED_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs']);

    const ignoredFn = (p: string, stats?: { isDirectory(): boolean }) => {
      const full = abs(p);
      for (const dir of ignoredOutDirs) {
        if (full === dir || isInside(full, dir)) return true;
      }
      // A directory is never ignored: chokidar has to descend into it to reach the files.
      if (stats?.isDirectory()) return false;
      const ext = path.extname(full);
      // Without stats chokidar is asking about a path it has not resolved yet. An extensionless
      // one is almost certainly a directory, so let it through and decide once it is known.
      if (!ext) return false;
      return !WATCHED_EXTENSIONS.has(ext);
    };

    const watcher = chokidar.watch(Array.from(currentTargets), {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 400, pollInterval: 50 },
      usePolling: !!opts.poll,
      ignored: ignoredFn,
    });

    const logTrigger = (type: 'add' | 'change' | 'unlink', file: string) => {
      if (opts.json) out.jsonData({ event: 'trigger', type, file });
    };

    watcher
      .on('add', (p) => {
        logTrigger('add', p);
        trigger(p);
      })
      .on('change', (p) => {
        logTrigger('change', p);
        trigger(p);
      })
      .on('unlink', (p) => {
        logTrigger('unlink', p);
        trigger(p);
      });

    let lastFiles: string[] = [];

    /**
     * One generator finishing a watch rebuild, reported the same way for every kind.
     *
     * The event keys are the ones `--json` has always emitted, because a watch feeding a script is
     * the only reader that shape has. The human form is narration, so it goes to stderr with
     * everything else this command prints.
     */
    const watchGenerated = (kind: string, files: string[]) => {
      if (opts.json) {
        out.jsonData({ event: 'generate_complete', kind, files });
        return;
      }
      out.succeed(
        out.errStyle.green(`Generated (${kind}): ${files.length} files`) +
          (files.length ? ' ' + files.map((f) => out.errStyle.cyan(f)).join(', ') : '')
      );
    };

    const run = async () => {
      try {
        const reloaded = await loadConfig(opts.config, (w) => out.warn(w));
        if (!reloaded) throw new Error('Config disappeared during watch.');
        cfg = reloaded;

        // Re-resolved on every rebuild, for the same reason the config is: an edit to
        // drizzle.config.ts mid-watch changes which files are the schema, and a new file that
        // matches its glob has to join the set. The watch targets are recomputed from the
        // fresh resolution, so a schema directory added to the kit config starts being
        // watched on the rebuild that first read it.
        source = await resolveSchemaSource(cfg);
        // The same single-file fill `generate` makes, for the same consumer (`schemaPath` in
        // validation-options.ts), so the two dispatch loops hand the generators the same
        // options and the branch-parity contract holds for interop configs too.
        if (!cfg.schema && Array.isArray(source.schema) && source.schema.length === 1) {
          cfg = { ...cfg, schema: source.schema[0] };
        }

        rebuildIgnoreDirsFrom(cfg);
        const nextTargets = new Set<string>(
          computeWatchTargets(cfg, process.cwd(), source).map(abs)
        );
        syncWatcherTargets(watcher, nextTargets);

        clearScreen();

        if (opts.json) {
          out.jsonData({
            event: 'watch_config_applied',
            targets: Array.from(currentTargets),
            ignored: Array.from(ignoredOutDirs),
          });
        }

        // After the clear above, or the warning would be wiped before anyone saw it.
        for (const w of source.warnings) out.warn(w);

        const analyzer = new SchemaAnalyzer(source.schema);
        const analysis = await analyzer.analyze({
          includeRelations: cfg.analyzer.includeRelations,
          validateConstraints: cfg.analyzer.validateConstraints,
          includeHeuristicRelations: cfg.analyzer.includeHeuristicRelations,
        });
        // The same cross-check `generate` makes, in the same wording, so the two commands
        // cannot disagree about what a contradictory dialect line means.
        const dialectWarning = dialectMismatchWarning({
          configPath: source.drizzleKitConfigPath ?? '',
          declared: source.drizzleKitDialect,
          analyzed: analysis.dialect,
        });
        if (dialectWarning) out.warn(dialectWarning);
        const loadFailure = schemaLoadFailure(analysis.issues, source.schema);
        if (loadFailure) {
          reportWatchProblem(loadFailure);
          return;
        }
        // Same order and the same reasons as `generate`. A config edited mid-watch that names a
        // column that does not exist throws here, and `run`'s own catch reports it and keeps
        // watching, so the next save can fix it.
        const narrowed = filterColumns(analysis.tables, cfg.columns);
        const filterWarnings = tableFilterWarnings(narrowed.tables, cfg);
        analysis.tables = filterTables(narrowed.tables, cfg);
        for (const w of [...narrowed.warnings, ...filterWarnings]) out.warn(w);
        for (const w of wideColumnWarning(analysis.issues)) out.warn(w);

        if (selection.analyzeOnly) {
          if (opts.json) {
            out.jsonData({
              event: 'analyze_complete',
              issues: analysis.issues,
              tables: analysis.tables.length,
            });
          } else {
            out.succeed('Analyze complete.');
          }
          return;
        }

        // Item 71, and after the analyze pipeline rather than before it, so the two commands that
        // report an analysis agree: `drzl analyze` on a schema with no tables exits 0 and prints
        // an analysis with none, because that is a true answer to the question it was asked.
        // Generating from it is a different question, and the answer to that one is that there is
        // nothing to write.
        const empty = nothingToGenerate({
          schema: source.schema,
          analyzed: narrowed.tables,
          remaining: analysis.tables,
        });
        if (empty) {
          reportWatchProblem(empty);
          return;
        }

        const newFiles: string[] = [];

        // Where the service generator is really writing, so a router template that imports
        // services spells a path that exists. `generate` has always computed this; `watch` did
        // not, so a rebuild silently emitted the default. One function now, shared by both.
        const servicesDir = resolveServicesDir(cfg);

        // A selection that names a kind this config does not is reported and waited out rather
        // than fatal, unlike an unknown kind on the command line: the config is reloaded on every
        // rebuild, so adding the generator to it is a save away.
        const unmatched = emptySelectionMessage(selection.kinds, cfg.generators);
        if (unmatched) {
          if (opts.json) out.jsonData({ event: 'error', code: 'DRZL_CLI_ONLY', message: unmatched });
          else {
            out.error(unmatched);
            out.hint('Add it to "generators" in your config, or name a kind that is already there.');
          }
          return;
        }

        for (const g of selectGenerators(cfg.generators, selection.kinds)) {
          // The registry, the same list `generate` dispatches over. Two hand-written copies of
          // this chain are what let five validation options reach one command and not the other,
          // and what left `watch` with no json-schema branch at all for a while.
          const entry = GENERATOR_BY_KIND.get(g.kind);
          if (!entry) continue;
          try {
            const files = await runGenerator(entry, g, cfg, { analysis, servicesDir });
            watchGenerated(g.kind, files);
            newFiles.push(...files);
          } catch (e: any) {
            reportGeneratorFailure(out, g.kind, e);
            return;
          }
        }

        const added = newFiles.filter((f) => !lastFiles.includes(f));
        const removed = lastFiles.filter((f) => !newFiles.includes(f));
        if (opts.json) {
          out.jsonData({ event: 'diff', added, removed });
        } else {
          if (added.length) out.note(out.errStyle.blue(`Added: ${added.join(', ')}`));
          if (removed.length) out.warn(`Removed: ${removed.join(', ')}`);
        }
        if (newFiles.length) {
          // The kinds this rebuild ran, however they were named. `--pipeline generate-trpc` and
          // `--only trpc` are the same run and now report the same reason.
          const reason = selection.kinds ? `watch:${[...selection.kinds].join(',')}` : 'watch';
          maybeShowSponsorMessage({ reason, out });
        }
        lastFiles = newFiles;
      } catch (e: any) {
        const msg = messageOf(e);
        if (opts.json) out.jsonData({ event: 'error', message: msg });
        else out.error('Watch pipeline failed:', msg);
      }
    };

    // Item 75. The debounce that was here collapsed the wait and not the work, so a change
    // arriving during a rebuild started a second one on top of it; see `watch-loop.ts` for the
    // measurement. `run` itself is unchanged, and the scheduler decides when it happens.
    const scheduler = createRebuildScheduler({
      run,
      debounceMs: resolveDebounce(opts.debounce, (w) => out.warn(w)),
    });

    const trigger = (file?: string) => {
      if (file) {
        const full = abs(file);
        for (const dir of ignoredOutDirs) {
          if (full === dir || isInside(full, dir)) return;
        }
      }
      scheduler.trigger();
    };

    if (opts.json) {
      out.jsonData({
        event: 'watching',
        targets: Array.from(currentTargets),
        ignored: Array.from(ignoredOutDirs),
      });
    } else {
      out.note(
        out.errStyle.gray(
          'Watching:\n  ' +
            Array.from(currentTargets)
              .map((p) => path.relative(process.cwd(), p))
              .join('\n  ')
        )
      );
    }

    watcher
      .on('add', (p) => trigger(p))
      .on('change', (p) => trigger(p))
      .on('unlink', (p) => trigger(p))
      .on('error', (err) => out.error('Watcher error:', messageOf(err)));

    // Through the same guard as every later rebuild, so a save landing during the startup build
    // waits for it rather than racing it. The watcher is attached by now, which is exactly when
    // that becomes possible.
    await scheduler.runNow();
  });

withOutputFlags(
  program
    .command('init')
    .description('Scaffold a drzl.config.ts, finding your schema and asking what to generate')
    .option('-y, --yes', 'take the defaults and ask nothing')
    .option('--schema <path>', 'the schema file to write into the config, skipping detection')
    .option(
      '--generators <list>',
      `comma-separated: ${INIT_GENERATOR_CHOICES.map((c) => c.kind).join(', ')}`
    )
).action(async (opts: any) => {
  const out = outputFor(opts);
  const failures: string[] = [];
  // Every prompt has a flag, and every flag skips its prompt. That equivalence is what keeps
  // the interactive command usable from CI: nothing can only be answered by a human.
  //
  // `--json` forces the non-interactive path as well as the shape. A prompt written into a
  // document is a question nobody will answer and a document nobody can parse, and `--json` is
  // only ever passed by something that is not a person.
  const outcome = await runInit({
    cwd: process.cwd(),
    yes: !!opts.yes || !!opts.json,
    schemaFlag: opts.schema,
    generatorsFlag: opts.generators,
    stdin: process.stdin,
    stdout: process.stdout,
    env: process.env,
    // Narration on stderr, all of it: what `init` produces is a file on disk, and the lines it
    // prints are a report about that.
    log: (s) => out.note(s.startsWith('Created ') ? out.errStyle.green(s) : out.errStyle.gray(s)),
    error: (s) => {
      failures.push(s);
      out.error(s);
    },
  });
  if (opts.json) {
    out.jsonData(
      outcome.code === 0
        ? {
            ok: true,
            command: 'init',
            exitCode: EXIT_OK,
            written: outcome.written,
            schema: outcome.plan?.schema ?? null,
            schemaSource: outcome.plan?.schemaSource ?? null,
            generators: outcome.plan?.generators ?? [],
          }
        : jsonFailure('init', 'DRZL_CLI_INIT', failures.join(' ') || 'init did not write a config')
    );
  }
  process.exit(outcome.code === 0 ? EXIT_OK : EXIT_FAILED);
});

/**
 * Tell the user which columns got a validator that accepts anything.
 *
 * This is the user-facing half of a check `verify-packed.sh` runs on this repository. Two real
 * bugs took exactly this shape, `.array()` and `pgEnum` columns coming back untyped on
 * drizzle-orm 0.4x, and the only way anyone noticed was reading the generated file. A user whose
 * schema uses a type nobody here has modelled gets the same silence, and no gate of ours helps
 * them.
 *
 * Printed once with a count rather than a line per column, so a schema with fifty custom types
 * stays readable.
 */
function wideColumnWarning(
  issues: Array<{ code?: string; message?: string; hint?: string }>
): string[] {
  const wide = issues.filter((i) => i.code === 'DRZL_ANL_UNKNOWN_COLUMN');
  if (!wide.length) return [];
  // One string rather than a write per line. The caller both prints it and puts it in the
  // `--json` document, and a warning split across six writes cannot be put in a document at all
  // without the two shapes drifting apart.
  const lines = [`\n${wide.length} column${wide.length === 1 ? '' : 's'} could not be typed:`];
  for (const i of wide.slice(0, 10)) lines.push(`  - ${i.message}`);
  if (wide.length > 10) lines.push(`  ... and ${wide.length - 10} more`);
  // One hint for the set, since they are almost always the same two.
  for (const h of [...new Set(wide.map((i) => i.hint).filter(Boolean))]) lines.push(`  ${h}`);
  // Untypeable columns are the only thing this line can see. A CHECK constraint the generators
  // decline produces no output at all and so cannot be counted here without parsing every one of
  // them on the generate path, which is what `doctor` is for.
  lines.push('  Run `drzl doctor` for the full report.');
  return [lines.join('\n')];
}

program.parseAsync(process.argv);
