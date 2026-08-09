#!/usr/bin/env node
import { SchemaAnalyzer } from '@drzl/analyzer';
import { ORPCGenerator } from '@drzl/generator-orpc';
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
import { jsonSchemaOptions } from './json-schema-options.js';
import { trpcOptions } from './trpc-options.js';
import { honoOptions } from './hono-options.js';
import { expressOptions } from './express-options.js';
import { fastifyOptions } from './fastify-options.js';
import { nestjsOptions } from './nestjs-options.js';
import { graphqlOptions } from './graphql-options.js';
import { validationOptions } from './validation-options';
import {
  computeGeneratorOutputDirs,
  computeWatchTargets,
  DrzlConfig,
  filterTables,
  loadConfig,
  tableFilterWarnings,
} from './config.js';
import { ConfigValidationError } from './config-errors.js';
import {
  nothingToGenerate,
  schemaLoadFailure,
  type SchemaProblem,
} from './schema-outcome.js';
import { filterColumns } from './column-filter.js';
import {
  dialectMismatchWarning,
  resolveSchemaSource,
  type ResolvedSchemaSource,
} from './drizzle-kit.js';
import { buildDoctorReport, renderDoctorReport } from './doctor.js';
import { diffSnapshots, restoreSnapshot, snapshotAll } from './drift.js';
import { GeneratorNotInstalledError, loadGenerator } from './generator-loader.js';
import { INIT_GENERATOR_CHOICES, runInit } from './init.js';
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

withOutputFlags(
  program
    .command('generate')
    .description('Run configured generators (drzl.config.*)')
    .option('-c, --config <path>', 'path to drzl.config')
    .option(
      '--check',
      'regenerate and fail if the result differs from what is on disk, without changing it'
    )
).action(async (opts: any) => {
  const out = outputFor(opts);
  /** Everything the `--json` document reports, filled in as the run makes it true. */
  const emitted: Array<{ kind: string; files: string[] }> = [];
  const warnings: string[] = [];
  /** A warning goes to stderr for a human and into the document for a machine, never both. */
  const warn = (text: string) => {
    warnings.push(text);
    out.warn(text);
  };
  {
    try {
      // The config's own warnings go through `warn`, so they reach the `--json` document and
      // `--quiet` removes them, exactly like every other warning this command produces. They used
      // to be written with `console.warn` from inside `loadConfig`, which neither flag could see.
      let cfg = await loadConfig(opts.config, warn);
      if (!cfg) {
        const msg = 'No config found (DRZL_CFG_001). Create drzl.config.ts or pass --config.';
        // Was exit 2 until now, which the scheme reserves for a run that found something. A
        // config that is not there is a run that could not start.
        if (opts.json) out.jsonData(jsonFailure('generate', 'DRZL_CFG_001', msg));
        else out.error(msg);
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
      // Under --check the existing output is captured before anything overwrites it, so the
      // regenerated result can be compared against it and the tree put back either way.
      const driftDirs = computeGeneratorOutputDirs(cfg);
      const driftBefore = opts.check ? await snapshotAll(driftDirs) : null;
      const total = analysis.tables.length || 1;
      // Whether this draws anything at all is `shouldShowProgress`'s decision: a terminal, no
      // `--quiet`, no `--json`, and enough tables that the bar will move (item 72).
      const progress = out.progress(total);
      /** One completed generator, reported the same way whichever branch produced it. */
      const generated = (kind: string, files: string[]) => {
        progress.stop();
        emitted.push({ kind, files });
        if (opts.json) return;
        // stdout, and deliberately: for `generate` the list of files written is the answer, and a
        // caller without `--json` has nothing else to read. `--quiet` is what removes it.
        if (out.quiet) return;
        out.succeed(out.errStyle.green(`Generated (${kind}): ${files.length} files`));
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
      // services spells a path that exists. Templates default this to 'src/services', and with
      // nothing passed that default was used no matter where the services really went, emitting
      // an import of a module that was never created. Must match the `g.path ?? 'src/services'`
      // used by the service branch below.
      const servicesDir =
        cfg.generators.find((x: { kind: string }) => x.kind === 'service')?.path ?? 'src/services';
      for (const g of cfg.generators) {
        // Per generator rather than once outside the loop. The bar used to be started before the
        // loop and stopped by whichever branch ran first, so in a config with two generators the
        // second updated a bar that was already stopped and drew nothing at all.
        progress.start();
        if (g.kind === 'orpc') {
          const gen = new ORPCGenerator(analysis);
          const { files } = await gen.generate({
            outputDir: cfg.outDir,
            template: g.template,
            includeRelations: g.includeRelations,
            naming: g.naming,
            outputHeader: g.outputHeader,
            format: g.format,
            templateOptions: g.templateOptions,
            importExtension: g.importExtension,
            validation: g.validation,
            // Documented on this generator since it was added and never reachable from a config
            // file, because the config schema had no such key and zod stripped it in silence.
            databaseInjection: g.databaseInjection,
            servicesDir,
            onProgress: ({ index }) => progress.update(index),
          });
          generated(g.kind, files);
        } else if (g.kind === 'trpc') {
          try {
            // An optional dependency, like the json-schema generator and unlike oRPC. A package
            // that has never been published cannot publish through npm's trusted-publisher OIDC
            // flow, so its first version has to go out by hand; naming it as a hard dependency of
            // the CLI in the same release breaks `npm i @drzl/cli` for everyone until it exists.
            // A missing optional dependency is skipped by the installer rather than failing it,
            // which is why this one really can be absent on an ordinary install.
            const { TRPCGenerator } = await loadGenerator(
              '@drzl/generator-trpc',
              () => import('@drzl/generator-trpc')
            );
            const gen = new TRPCGenerator(analysis);
            const { files } = await gen.generate({
              ...trpcOptions(g, cfg, servicesDir),
              onProgress: ({ index }: { index: number }) => progress.update(index),
            });
            generated('trpc', files);
          } catch (e: any) {
            failGenerator(g.kind, e);
          }
        } else if (g.kind === 'hono') {
          try {
            // Optional for the same reason tRPC is: a package that has never been published
            // cannot publish through npm's trusted-publisher OIDC flow, so its first version goes
            // out by hand, and naming it as a hard dependency of the CLI in the same release
            // breaks `npm i @drzl/cli` for everyone until it exists.
            const { HonoGenerator } = await loadGenerator(
              '@drzl/generator-hono',
              () => import('@drzl/generator-hono')
            );
            const gen = new HonoGenerator(analysis);
            const { files } = await gen.generate({
              ...honoOptions(g, cfg),
              onProgress: ({ index }: { index: number }) => progress.update(index),
            });
            generated('hono', files);
          } catch (e: any) {
            failGenerator(g.kind, e);
          }
        } else if (g.kind === 'express') {
          try {
            // Optional for the same reason tRPC and Hono are: a package that has never been
            // published cannot publish through npm's trusted-publisher OIDC flow, so its first
            // version goes out by hand, and naming it as a hard dependency of the CLI in the same
            // release breaks `npm i @drzl/cli` for everyone until it exists.
            const { ExpressGenerator } = await loadGenerator(
              '@drzl/generator-express',
              () => import('@drzl/generator-express')
            );
            const gen = new ExpressGenerator(analysis);
            const { files } = await gen.generate({
              ...expressOptions(g, cfg),
              onProgress: ({ index }: { index: number }) => progress.update(index),
            });
            generated('express', files);
          } catch (e: any) {
            failGenerator(g.kind, e);
          }
        } else if (g.kind === 'fastify') {
          try {
            // Optional for the same reason tRPC, Hono and Express are: a package that has never
            // been published cannot publish through npm's trusted-publisher OIDC flow, so its
            // first version goes out by hand, and naming it as a hard dependency of the CLI in
            // the same release breaks `npm i @drzl/cli` for everyone until it exists.
            const { FastifyGenerator } = await loadGenerator(
              '@drzl/generator-fastify',
              () => import('@drzl/generator-fastify')
            );
            const gen = new FastifyGenerator(analysis);
            const { files } = await gen.generate({
              ...fastifyOptions(g, cfg),
              onProgress: ({ index }: { index: number }) => progress.update(index),
            });
            generated('fastify', files);
          } catch (e: any) {
            failGenerator(g.kind, e);
          }
        } else if (g.kind === 'nestjs') {
          try {
            // Optional for the same reason tRPC, Hono, Express and Fastify are: a package that
            // has never been published cannot publish through npm's trusted-publisher OIDC flow,
            // so its first version goes out by hand, and naming it as a hard dependency of the
            // CLI in the same release breaks `npm i @drzl/cli` for everyone until it exists.
            const { NestJSGenerator } = await loadGenerator(
              '@drzl/generator-nestjs',
              () => import('@drzl/generator-nestjs')
            );
            const gen = new NestJSGenerator(analysis);
            const { files } = await gen.generate({
              ...nestjsOptions(g, cfg),
              onProgress: ({ index }: { index: number }) => progress.update(index),
            });
            generated('nestjs', files);
          } catch (e: any) {
            failGenerator(g.kind, e);
          }
        } else if (g.kind === 'graphql') {
          try {
            // Optional for the same reason tRPC, Hono, Express, Fastify and NestJS are: a
            // package that has never been published cannot publish through npm's
            // trusted-publisher OIDC flow, so its first version goes out by hand, and naming it
            // as a hard dependency of the CLI in the same release breaks `npm i @drzl/cli` for
            // everyone until it exists.
            const { GraphQLGenerator } = await loadGenerator(
              '@drzl/generator-graphql',
              () => import('@drzl/generator-graphql')
            );
            const gen = new GraphQLGenerator(analysis);
            const { files } = await gen.generate({
              ...graphqlOptions(g, cfg),
              onProgress: ({ index }: { index: number }) => progress.update(index),
            });
            generated('graphql', files);
          } catch (e: any) {
            failGenerator(g.kind, e);
          }
        } else if (g.kind === 'service') {
          try {
            const { ServiceGenerator } = await loadGenerator(
              '@drzl/generator-service',
              () => import('@drzl/generator-service')
            );
            const gen = new ServiceGenerator(analysis);
            const target = g.path ?? 'src/services';
            const files = await gen.generate({
              outDir: target,
              outputHeader: g.outputHeader,
              format: g.format,
              dataAccess: g.dataAccess,
              dbImportPath: g.dbImportPath,
              schemaImportPath: g.schemaImportPath,
              importExtension: g.importExtension,
              // The other half of `databaseInjection`. A router generator in injection mode
              // emits `Service.getById(ctx.db, id)`, and only a service generated in the same
              // mode has a `db` parameter to receive it. This branch never passed the option, so
              // the two halves of one generated project disagreed about the signature.
              databaseInjection: g.databaseInjection,
            });
            generated('service', files);
          } catch (e: any) {
            failGenerator(g.kind, e);
          }
        } else if (g.kind === 'zod') {
          try {
            const { ZodGenerator } = await loadGenerator(
              '@drzl/generator-zod',
              () => import('@drzl/generator-zod')
            );
            const gen = new ZodGenerator(analysis);
            const target = g.path ?? 'src/validators/zod';
            // `meta` is zod-only; see `GeneratorCapabilities.meta` for why it is not passed to the
            // other four rather than being passed and ignored.
            const files = await gen.generate(
              validationOptions(g, cfg, target, {
                schemaTypes: true,
                meta: true,
                constraints: true,
              }) as never
            );
            generated('zod', files);
          } catch (e: any) {
            failGenerator(g.kind, e);
          }
        } else if (g.kind === 'valibot') {
          try {
            const { ValibotGenerator } = await loadGenerator(
              '@drzl/generator-valibot',
              () => import('@drzl/generator-valibot')
            );
            const gen = new ValibotGenerator(analysis);
            const target = g.path ?? 'src/validators/valibot';
            const files = await gen.generate(
              validationOptions(g, cfg, target, { schemaTypes: true, constraints: true }) as never
            );
            generated('valibot', files);
          } catch (e: any) {
            failGenerator(g.kind, e);
          }
        } else if (g.kind === 'arktype') {
          try {
            const { ArkTypeGenerator } = await loadGenerator(
              '@drzl/generator-arktype',
              () => import('@drzl/generator-arktype')
            );
            const gen = new ArkTypeGenerator(analysis);
            const target = g.path ?? 'src/validators/arktype';
            const files = await gen.generate(
              validationOptions(g, cfg, target, { schemaTypes: false }) as never
            );
            generated('arktype', files);
          } catch (e: any) {
            failGenerator(g.kind, e);
          }
        } else if (g.kind === 'json-schema') {
          try {
            // An optional dependency, unlike the other generators, until its npm trusted publisher
            // exists. A missing optional dependency is skipped rather than failing the install,
            // which is what keeps `npm i @drzl/cli` working meanwhile, and is why this one really
            // can be absent on a normal install.
            const { JsonSchemaGenerator } = await loadGenerator(
              '@drzl/generator-json-schema',
              () => import('@drzl/generator-json-schema')
            );
            const gen = new JsonSchemaGenerator(analysis);
            const target = g.path ?? 'src/validators/json-schema';
            const files = await gen.generate(jsonSchemaOptions(g, cfg, target) as never);
            generated('json-schema', files);
          } catch (e: any) {
            failGenerator(g.kind, e);
          }
        } else if (g.kind === 'typebox') {
          try {
            const { TypeBoxGenerator } = await loadGenerator(
              '@drzl/generator-typebox',
              () => import('@drzl/generator-typebox')
            );
            const gen = new TypeBoxGenerator(analysis);
            const target = g.path ?? 'src/validators/typebox';
            const files = await gen.generate(
              validationOptions(g, cfg, target, {
                schemaTypes: true,
                standardSchema: true,
              }) as never
            );
            generated('typebox', files);
          } catch (e: any) {
            failGenerator(g.kind, e);
          }
        } else if (g.kind === 'effect') {
          try {
            const { EffectGenerator } = await loadGenerator(
              '@drzl/generator-effect',
              () => import('@drzl/generator-effect')
            );
            const gen = new EffectGenerator(analysis);
            const target = g.path ?? 'src/validators/effect';
            const files = await gen.generate(
              validationOptions(g, cfg, target, { schemaTypes: true }) as never
            );
            generated('effect', files);
          } catch (e: any) {
            failGenerator(g.kind, e);
          }
        }
      }
      if (driftBefore) {
        const after = await snapshotAll(driftDirs);
        const drift = diffSnapshots(driftBefore, after);
        // Restored whether or not anything drifted, so `--check` never leaves the tree altered.
        await restoreSnapshot(driftBefore, after);

        const upToDate = drift.length === 0;
        // Drift is EXIT_FINDINGS, not EXIT_FAILED, and that is the whole reason the scheme has two
        // failure codes. The check ran perfectly: it regenerated, compared, restored the tree, and
        // is reporting what it found. A CI job that wants to show a diff acts on that differently
        // from a config it could not read, and until now both were 1.
        const code = upToDate ? EXIT_OK : EXIT_FINDINGS;

        if (opts.json) {
          out.jsonData({
            ok: true,
            command: 'generate',
            exitCode: code,
            check: {
              upToDate,
              drift: drift.map((d) => ({
                file: path.relative(process.cwd(), d.file),
                status: d.status,
              })),
            },
            generators: emitted.map((e) => ({ kind: e.kind, files: e.files })),
            warnings,
          });
          process.exit(code);
        }

        if (!upToDate) {
          out.error(`\nGenerated output is out of date (${drift.length} file(s)):`);
          for (const d of drift) {
            const mark = d.status === 'added' ? '+' : d.status === 'removed' ? '-' : '~';
            out.error(
              `  ${mark} ${out.errStyle.yellow(d.status.padEnd(8))} ${path.relative(process.cwd(), d.file)}`
            );
          }
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
          generators: emitted.map((e) => ({ kind: e.kind, files: e.files })),
          warnings,
        });
        return;
      }

      if (cfg.generators.length) {
        maybeShowSponsorMessage({ reason: 'generate', out });
      }
    } catch (e: any) {
      const msg = messageOf(e);
      const code = drzlErrorCode(e, 'DRZL_GEN_001');
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

withOutputFlags(
  program
    .command('generate:orpc')
    .argument('<schema>', 'path to drizzle schema (TS)')
    .option('-o, --outDir <dir>', 'output directory', 'src/api')
    .option('--template <name>', 'template name', 'standard')
    .option('--includeRelations', 'include relation endpoints')
).action(async (schema: string, opts: any) => {
  const out = outputFor(opts);
  try {
    const analyzer = new SchemaAnalyzer(schema);
    const analysis = await analyzer.analyze({
      includeRelations: !!opts.includeRelations,
      validateConstraints: true,
    });
    const problem = schemaProblemFor(analysis, schema);
    if (problem) reportSchemaProblem(out, 'generate:orpc', problem);
    const gen = new ORPCGenerator(analysis);
    const { files } = await gen.generate({
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
    const msg = messageOf(e);
    if (opts.json) out.jsonData(jsonFailure('generate:orpc', 'DRZL_CLI_ORPC', msg));
    else out.error('Generate orpc failed:', msg);
    process.exit(EXIT_FAILED);
  }
});

withOutputFlags(
  program
    .command('generate:trpc')
    .argument('<schema>', 'path to drizzle schema (TS)')
    .option('-o, --outDir <dir>', 'output directory', 'src/api')
    .option('--template <name>', 'standard | service', 'standard')
    .option('--includeRelations', 'include relation endpoints')
    .option('--servicesDir <dir>', 'where the service generator writes', 'src/services')
).action(async (schema: string, opts: any) => {
  const out = outputFor(opts);
  try {
    const analyzer = new SchemaAnalyzer(schema);
    const analysis = await analyzer.analyze({
      includeRelations: !!opts.includeRelations,
      validateConstraints: true,
    });
    const problem = schemaProblemFor(analysis, schema);
    if (problem) reportSchemaProblem(out, 'generate:trpc', problem);
    const { TRPCGenerator } = await loadGenerator(
      '@drzl/generator-trpc',
      () => import('@drzl/generator-trpc')
    );
    const gen = new TRPCGenerator(analysis);
    const { files } = await gen.generate({
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
    '--pipeline <name>',
    'all | analyze | generate-orpc | generate-trpc | generate-hono | generate-express | generate-fastify | generate-nestjs | generate-graphql',
    'all'
  )
  .option('--debounce <ms>', 'debounce ms', '200')
  .option('--json', 'emit JSON logs', false)
  .option('-q, --quiet', 'drop the progress narration on stderr; errors still print', false)
  .option('--poll', 'force polling (helps WSL/Docker/remote FS)', false)
  .action(async (opts: any) => {
    // `watch` has no answer to give: it is narration until it is stopped. So everything human it
    // prints goes to stderr, and stdout carries only the `--json` event stream, which is the one
    // thing here a program reads.
    const out = outputFor(opts);

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
     * One generator finishing a watch rebuild, reported the same way from all thirteen branches.
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

        if (!opts.json) console.clear();

        if (opts.json) {
          out.jsonData({
            event: 'watch_config_applied',
            targets: Array.from(currentTargets),
            ignored: Array.from(ignoredOutDirs),
          });
        }

        // After the console.clear() above, or the warning would be wiped before anyone saw it.
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

        if (opts.pipeline === 'analyze') {
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

        // Must match the `g.path ?? 'src/services'` the service branch below uses, or a router
        // template that imports services spells a path nothing ever wrote. `generate` has always
        // computed this; `watch` did not, so a rebuild silently emitted the default.
        const servicesDir =
          cfg.generators.find((x: { kind: string }) => x.kind === 'service')?.path ??
          'src/services';

        const PIPELINE_KINDS: Record<string, string> = {
          'generate-orpc': 'orpc',
          'generate-trpc': 'trpc',
          'generate-hono': 'hono',
          'generate-express': 'express',
          'generate-fastify': 'fastify',
          'generate-nestjs': 'nestjs',
          'generate-graphql': 'graphql',
        };

        for (const g of cfg.generators) {
          if (opts.pipeline !== 'all' && PIPELINE_KINDS[opts.pipeline] !== g.kind) {
            continue;
          }

          if (g.kind === 'orpc') {
            const gen = new ORPCGenerator(analysis);
            const { files } = await gen.generate({
              outputDir: cfg.outDir,
              template: g.template,
              includeRelations: g.includeRelations,
              naming: g.naming,
              outputHeader: g.outputHeader,
              format: g.format,
              templateOptions: g.templateOptions,
              importExtension: g.importExtension,
              validation: g.validation,
              databaseInjection: g.databaseInjection,
              servicesDir,
            });
            watchGenerated(g.kind, files);
            newFiles.push(...files);
          } else if (g.kind === 'trpc') {
            try {
              const { TRPCGenerator } = await loadGenerator(
                '@drzl/generator-trpc',
                () => import('@drzl/generator-trpc')
              );
              const gen = new TRPCGenerator(analysis);
              // The same builder `generate` uses, so the two dispatch loops cannot disagree
              // about what this generator is given.
              const { files } = await gen.generate(trpcOptions(g, cfg, servicesDir));
              watchGenerated(g.kind, files);
              newFiles.push(...files);
            } catch (e: any) {
              reportGeneratorFailure(out, g.kind, e);
              return;
            }
          } else if (g.kind === 'hono') {
            try {
              const { HonoGenerator } = await loadGenerator(
                '@drzl/generator-hono',
                () => import('@drzl/generator-hono')
              );
              const gen = new HonoGenerator(analysis);
              // The same builder `generate` uses, so the two dispatch loops cannot disagree
              // about what this generator is given.
              const { files } = await gen.generate(honoOptions(g, cfg));
              watchGenerated(g.kind, files);
              newFiles.push(...files);
            } catch (e: any) {
              reportGeneratorFailure(out, g.kind, e);
              return;
            }
          } else if (g.kind === 'express') {
            try {
              const { ExpressGenerator } = await loadGenerator(
                '@drzl/generator-express',
                () => import('@drzl/generator-express')
              );
              const gen = new ExpressGenerator(analysis);
              // The same builder `generate` uses, so the two dispatch loops cannot disagree
              // about what this generator is given.
              const { files } = await gen.generate(expressOptions(g, cfg));
              watchGenerated(g.kind, files);
              newFiles.push(...files);
            } catch (e: any) {
              reportGeneratorFailure(out, g.kind, e);
              return;
            }
          } else if (g.kind === 'fastify') {
            try {
              const { FastifyGenerator } = await loadGenerator(
                '@drzl/generator-fastify',
                () => import('@drzl/generator-fastify')
              );
              const gen = new FastifyGenerator(analysis);
              // The same builder `generate` uses, so the two dispatch loops cannot disagree
              // about what this generator is given.
              const { files } = await gen.generate(fastifyOptions(g, cfg));
              watchGenerated(g.kind, files);
              newFiles.push(...files);
            } catch (e: any) {
              reportGeneratorFailure(out, g.kind, e);
              return;
            }
          } else if (g.kind === 'nestjs') {
            try {
              const { NestJSGenerator } = await loadGenerator(
                '@drzl/generator-nestjs',
                () => import('@drzl/generator-nestjs')
              );
              const gen = new NestJSGenerator(analysis);
              // The same builder `generate` uses, so the two dispatch loops cannot disagree
              // about what this generator is given.
              const { files } = await gen.generate(nestjsOptions(g, cfg));
              watchGenerated(g.kind, files);
              newFiles.push(...files);
            } catch (e: any) {
              reportGeneratorFailure(out, g.kind, e);
              return;
            }
          } else if (g.kind === 'graphql') {
            try {
              const { GraphQLGenerator } = await loadGenerator(
                '@drzl/generator-graphql',
                () => import('@drzl/generator-graphql')
              );
              const gen = new GraphQLGenerator(analysis);
              // The same builder `generate` uses, so the two dispatch loops cannot disagree
              // about what this generator is given.
              const { files } = await gen.generate(graphqlOptions(g, cfg));
              watchGenerated(g.kind, files);
              newFiles.push(...files);
            } catch (e: any) {
              reportGeneratorFailure(out, g.kind, e);
              return;
            }
          } else if (g.kind === 'service') {
            try {
              const { ServiceGenerator } = await loadGenerator(
                '@drzl/generator-service',
                () => import('@drzl/generator-service')
              );
              const gen = new ServiceGenerator(analysis);
              const target = g.path ?? 'src/services';
              const files = await gen.generate({
                outDir: target,
                outputHeader: g.outputHeader,
                format: g.format,
                dataAccess: g.dataAccess,
                dbImportPath: g.dbImportPath,
                schemaImportPath: g.schemaImportPath,
                importExtension: g.importExtension,
                databaseInjection: g.databaseInjection,
              });
              watchGenerated(g.kind, files);
              newFiles.push(...files);
            } catch (e: any) {
              reportGeneratorFailure(out, g.kind, e);
              return;
            }
          } else if (g.kind === 'zod') {
            try {
              const { ZodGenerator } = await loadGenerator(
                '@drzl/generator-zod',
                () => import('@drzl/generator-zod')
              );
              const gen = new ZodGenerator(analysis);
              const target = g.path ?? 'src/validators/zod';
              // `meta` is zod-only; see `GeneratorCapabilities.meta` for why it is not passed to
              // the other four rather than being passed and ignored.
              // The same builder `generate` uses. Assembled by hand here until now, and every
              // option added since the builder existed was therefore absent from a watch rebuild:
              // `coerceDates`, `applyDefaults`, `typedJson`, `typedColumns` and `duplicateFinder`
              // were all dropped, so the first save after starting `drzl watch` silently replaced
              // correct output with output generated from defaults.
              const files = await gen.generate(
                validationOptions(g, cfg, target, {
                  schemaTypes: true,
                  meta: true,
                  constraints: true,
                }) as never
              );
              watchGenerated(g.kind, files);
              newFiles.push(...files);
            } catch (e: any) {
              reportGeneratorFailure(out, g.kind, e);
              return;
            }
          } else if (g.kind === 'valibot') {
            try {
              const { ValibotGenerator } = await loadGenerator(
                '@drzl/generator-valibot',
                () => import('@drzl/generator-valibot')
              );
              const gen = new ValibotGenerator(analysis);
              const target = g.path ?? 'src/validators/valibot';
              // The same builder `generate` uses. Assembled by hand here until now, and every
              // option added since the builder existed was therefore absent from a watch rebuild:
              // `coerceDates`, `applyDefaults`, `typedJson`, `typedColumns` and `duplicateFinder`
              // were all dropped, so the first save after starting `drzl watch` silently replaced
              // correct output with output generated from defaults.
              const files = await gen.generate(
                validationOptions(g, cfg, target, {
                  schemaTypes: true,
                  constraints: true,
                }) as never
              );
              watchGenerated(g.kind, files);
              newFiles.push(...files);
            } catch (e: any) {
              reportGeneratorFailure(out, g.kind, e);
              return;
            }
          } else if (g.kind === 'arktype') {
            try {
              const { ArkTypeGenerator } = await loadGenerator(
                '@drzl/generator-arktype',
                () => import('@drzl/generator-arktype')
              );
              const gen = new ArkTypeGenerator(analysis);
              const target = g.path ?? 'src/validators/arktype';
              // The same builder `generate` uses. Assembled by hand here until now, and every
              // option added since the builder existed was therefore absent from a watch rebuild:
              // `coerceDates`, `applyDefaults`, `typedJson`, `typedColumns` and `duplicateFinder`
              // were all dropped, so the first save after starting `drzl watch` silently replaced
              // correct output with output generated from defaults.
              const files = await gen.generate(
                validationOptions(g, cfg, target, { schemaTypes: false }) as never
              );
              watchGenerated(g.kind, files);
              newFiles.push(...files);
            } catch (e: any) {
              reportGeneratorFailure(out, g.kind, e);
              return;
            }
          } else if (g.kind === 'typebox') {
            try {
              const { TypeBoxGenerator } = await loadGenerator(
                '@drzl/generator-typebox',
                () => import('@drzl/generator-typebox')
              );
              const gen = new TypeBoxGenerator(analysis);
              const target = g.path ?? 'src/validators/typebox';
              // The same builder `generate` uses. Assembled by hand here until now, and every
              // option added since the builder existed was therefore absent from a watch rebuild:
              // `coerceDates`, `applyDefaults`, `typedJson`, `typedColumns` and `duplicateFinder`
              // were all dropped, so the first save after starting `drzl watch` silently replaced
              // correct output with output generated from defaults.
              const files = await gen.generate(
                validationOptions(g, cfg, target, {
                  schemaTypes: true,
                  standardSchema: true,
                }) as never
              );
              watchGenerated(g.kind, files);
              newFiles.push(...files);
            } catch (e: any) {
              reportGeneratorFailure(out, g.kind, e);
              return;
            }
          } else if (g.kind === 'effect') {
            try {
              const { EffectGenerator } = await loadGenerator(
                '@drzl/generator-effect',
                () => import('@drzl/generator-effect')
              );
              const gen = new EffectGenerator(analysis);
              const target = g.path ?? 'src/validators/effect';
              // The same builder `generate` uses, and the same default path, which is also the one
              // `computeGeneratorOutputDirs` has to spell: a watcher that does not ignore this
              // directory regenerates on its own output forever.
              const files = await gen.generate(
                validationOptions(g, cfg, target, { schemaTypes: true }) as never
              );
              watchGenerated(g.kind, files);
              newFiles.push(...files);
            } catch (e: any) {
              reportGeneratorFailure(out, g.kind, e);
              return;
            }
          } else if (g.kind === 'json-schema') {
            try {
              const { JsonSchemaGenerator } = await loadGenerator(
                '@drzl/generator-json-schema',
                () => import('@drzl/generator-json-schema')
              );
              const gen = new JsonSchemaGenerator(analysis);
              const target = g.path ?? 'src/validators/json-schema';
              // The same builder `generate` uses, so the two dispatch loops cannot disagree about
              // what this generator is given.
              const files = await gen.generate(jsonSchemaOptions(g, cfg, target) as never);
              watchGenerated(g.kind, files);
              newFiles.push(...files);
            } catch (e: any) {
              reportGeneratorFailure(out, g.kind, e);
              return;
            }
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
          const reason =
            opts.pipeline && opts.pipeline !== 'all' ? `watch:${opts.pipeline}` : 'watch';
          maybeShowSponsorMessage({ reason, out });
        }
        lastFiles = newFiles;
      } catch (e: any) {
        const msg = messageOf(e);
        if (opts.json) out.jsonData({ event: 'error', message: msg });
        else out.error('Watch pipeline failed:', msg);
      }
    };

    const debounced = Number(opts.debounce) || 200;
    let timer: NodeJS.Timeout | null = null;
    const trigger = (file?: string) => {
      if (file) {
        const full = abs(file);
        for (const dir of ignoredOutDirs) {
          if (full === dir || isInside(full, dir)) return;
        }
      }
      if (timer) clearTimeout(timer);
      timer = setTimeout(run, debounced);
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

    await run();
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
