#!/usr/bin/env node
import { SchemaAnalyzer } from '@drzl/analyzer';
import { ORPCGenerator } from '@drzl/generator-orpc';
import chalk from 'chalk';
import chokidar from 'chokidar';
import cliProgress from 'cli-progress';
import { Command } from 'commander';
import * as path from 'node:path';
import ora from 'ora';
import { validationOptions } from './validation-options';
import {
  computeGeneratorOutputDirs,
  computeWatchTargets,
  DrzlConfig,
  filterTables,
  loadConfig,
} from './config.js';
import { diffSnapshots, restoreSnapshot, snapshotAll } from './drift.js';
import { maybeShowSponsorMessage } from './sponsor.js';
import { CLI_VERSION } from './version.js';

const program = new Command();
program.name('drzl').description('DRZL - Drizzle Developer Toolkit').version(CLI_VERSION);
program.addHelpText(
  'afterAll',
  `\nNeed a template, adapter, or generator DRZL doesn't ship yet?\n→ DM @omardulaimidev on X: https://x.com/omardulaimidev\n`
);

program
  .command('analyze')
  .argument('<schema>', 'path to drizzle schema (TS)')
  .option('--relations', 'include relations', true)
  .option('--validate', 'validate constraints', true)
  .option('--out <file>', 'write analysis JSON to file')
  .option('--json', 'print JSON to stdout (overrides --out)', false)
  .action(async (schema: string, opts: any) => {
    try {
      const analyzer = new SchemaAnalyzer(schema);
      const spinner = !opts.json ? ora('Analyzing schema...').start() : null;
      const start = Date.now();
      const res = await analyzer.analyze({
        includeRelations: !!opts.relations,
        validateConstraints: !!opts.validate,
      });
      const ms = Date.now() - start;
      const json = JSON.stringify(res, null, 2);
      if (opts.json) {
        console.log(json);
      } else if (opts.out) {
        const fs = await import('node:fs/promises');
        await fs.writeFile(opts.out, json, 'utf8');
        spinner?.succeed(chalk.green(`Analysis written to ${opts.out} in ${ms}ms`));
      } else {
        spinner?.succeed(chalk.green(`Analyzed in ${ms}ms`));
        console.log(json);
      }
      process.exit(res.issues.some((i) => i.level === 'error') ? 2 : 0);
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      if (opts.json)
        console.log(JSON.stringify({ event: 'error', code: 'DRZL_CLI_ANALYZE', message: msg }));
      else
        console.error(
          chalk.red('Analyze failed (DRZL_CLI_ANALYZE):'),
          msg,
          '\nTip: run with --json for structured output.'
        );
      process.exit(1);
    }
  });

program
  .command('generate')
  .description('Run configured generators (drzl.config.*)')
  .option('-c, --config <path>', 'path to drzl.config')
  .option(
    '--check',
    'regenerate and fail if the result differs from what is on disk, without changing it'
  )
  .action(async (opts: any) => {
    try {
      const cfg = await loadConfig(opts.config);
      if (!cfg) {
        console.error(
          chalk.red('No config found (DRZL_CFG_001). Create drzl.config.ts or pass --config.')
        );
        process.exit(2);
        return;
      }
      const analyzer = new SchemaAnalyzer(cfg.schema);
      const spinner = ora('Analyzing...').start();
      const t0 = Date.now();
      const analysis = await analyzer.analyze({
        includeRelations: cfg.analyzer.includeRelations,
        validateConstraints: cfg.analyzer.validateConstraints,
        includeHeuristicRelations: cfg.analyzer.includeHeuristicRelations,
      });
      // Applied before any generator sees the analysis, so every one of them honours it without
      // needing to know the option exists.
      analysis.tables = filterTables(analysis.tables, cfg);
      spinner.succeed(`Analysis complete in ${Date.now() - t0}ms`);
      reportWideColumns(analysis.issues);
      // Under --check the existing output is captured before anything overwrites it, so the
      // regenerated result can be compared against it and the tree put back either way.
      const driftDirs = computeGeneratorOutputDirs(cfg);
      const driftBefore = opts.check ? await snapshotAll(driftDirs) : null;
      const progress = new cliProgress.SingleBar(
        { hideCursor: true },
        cliProgress.Presets.shades_classic
      );
      const total = analysis.tables.length || 1;
      progress.start(total, 0);
      // Where the service generator is actually writing, so a router template that imports
      // services spells a path that exists. Templates default this to 'src/services', and with
      // nothing passed that default was used no matter where the services really went, emitting
      // an import of a module that was never created. Must match the `g.path ?? 'src/services'`
      // used by the service branch below.
      const servicesDir =
        cfg.generators.find((x: { kind: string }) => x.kind === 'service')?.path ?? 'src/services';
      for (const g of cfg.generators) {
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
            servicesDir,
            onProgress: ({ index }) => progress.update(index),
          });
          progress.stop();
          ora().succeed(chalk.green(`Generated (${g.kind}): ${files.length} files`));
          files.forEach((f: string) => console.log('  -', chalk.cyan(f)));
        } else if (g.kind === 'service') {
          try {
            const { ServiceGenerator } = await import('@drzl/generator-service');
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
            });
            progress.stop();
            ora().succeed(chalk.green(`Generated (service): ${files.length} files`));
            files.forEach((f: string) => console.log('  -', chalk.cyan(f)));
          } catch (e: any) {
            progress.stop();
            console.error(
              chalk.red('Service generator missing.'),
              chalk.yellow('\nInstall with: npm install @drzl/generator-service')
            );
            console.error(chalk.gray('Error details:'), e?.message ?? e);
            process.exit(1);
          }
        } else if (g.kind === 'zod') {
          try {
            const { ZodGenerator } = await import('@drzl/generator-zod');
            const gen = new ZodGenerator(analysis);
            const target = g.path ?? 'src/validators/zod';
            const files = await gen.generate(
              validationOptions(g, cfg, target, { schemaTypes: true }) as never
            );
            progress.stop();
            ora().succeed(chalk.green(`Generated (zod): ${files.length} files`));
            files.forEach((f: string) => console.log('  -', chalk.cyan(f)));
          } catch (e: any) {
            progress.stop();
            console.error(
              chalk.red('Zod generator missing.'),
              chalk.yellow('\nInstall with: npm install @drzl/generator-zod')
            );
            console.error(chalk.gray('Error details:'), e?.message ?? e);
            process.exit(1);
          }
        } else if (g.kind === 'valibot') {
          try {
            const { ValibotGenerator } = await import('@drzl/generator-valibot');
            const gen = new ValibotGenerator(analysis);
            const target = g.path ?? 'src/validators/valibot';
            const files = await gen.generate(
              validationOptions(g, cfg, target, { schemaTypes: true }) as never
            );
            progress.stop();
            ora().succeed(chalk.green(`Generated (valibot): ${files.length} files`));
            files.forEach((f: string) => console.log('  -', chalk.cyan(f)));
          } catch (e: any) {
            progress.stop();
            console.error(
              chalk.red('Valibot generator missing.'),
              chalk.yellow('\nInstall with: npm install @drzl/generator-valibot')
            );
            console.error(chalk.gray('Error details:'), e?.message ?? e);
            process.exit(1);
          }
        } else if (g.kind === 'arktype') {
          try {
            const { ArkTypeGenerator } = await import('@drzl/generator-arktype');
            const gen = new ArkTypeGenerator(analysis);
            const target = g.path ?? 'src/validators/arktype';
            const files = await gen.generate(
              validationOptions(g, cfg, target, { schemaTypes: false }) as never
            );
            progress.stop();
            ora().succeed(chalk.green(`Generated (arktype): ${files.length} files`));
            files.forEach((f: string) => console.log('  -', chalk.cyan(f)));
          } catch (e: any) {
            progress.stop();
            console.error(
              chalk.red('ArkType generator missing.'),
              chalk.yellow('\nInstall with: npm install @drzl/generator-arktype')
            );
            console.error(chalk.gray('Error details:'), e?.message ?? e);
            process.exit(1);
          }
        } else if (g.kind === 'json-schema') {
          try {
            const { JsonSchemaGenerator } = await import('@drzl/generator-json-schema');
            const gen = new JsonSchemaGenerator(analysis);
            const target = g.path ?? 'src/validators/json-schema';
            const files = await gen.generate({
              // JSON Schema is data, so nothing here references a type from the schema module.
              ...(validationOptions(g, cfg, target, { schemaTypes: false }) as object),
              target: g.target,
              components: g.components,
            } as never);
            progress.stop();
            ora().succeed(chalk.green(`Generated (json-schema): ${files.length} files`));
            files.forEach((f: string) => console.log('  -', chalk.cyan(f)));
          } catch (e: any) {
            progress.stop();
            console.error(
              chalk.red('JSON Schema generator missing.'),
              chalk.yellow('\nInstall with: npm install @drzl/generator-json-schema'),
              // An optional dependency, unlike the other generators, until its npm trusted
              // publisher exists. A missing optional dependency is skipped rather than failing
              // the install, which is what keeps `npm i @drzl/cli` working meanwhile.
              ''
            );
            console.error(chalk.gray('Error details:'), e?.message ?? e);
            process.exit(1);
          }
        } else if (g.kind === 'typebox') {
          try {
            const { TypeBoxGenerator } = await import('@drzl/generator-typebox');
            const gen = new TypeBoxGenerator(analysis);
            const target = g.path ?? 'src/validators/typebox';
            const files = await gen.generate(
              validationOptions(g, cfg, target, { schemaTypes: true }) as never
            );
            progress.stop();
            ora().succeed(chalk.green(`Generated (typebox): ${files.length} files`));
            files.forEach((f: string) => console.log('  -', chalk.cyan(f)));
          } catch (e: any) {
            progress.stop();
            console.error(
              chalk.red('TypeBox generator missing.'),
              chalk.yellow('\nInstall with: npm install @drzl/generator-typebox')
            );
            console.error(chalk.gray('Error details:'), e?.message ?? e);
            process.exit(1);
          }
        }
      }
      if (driftBefore) {
        const after = await snapshotAll(driftDirs);
        const drift = diffSnapshots(driftBefore, after);
        // Restored whether or not anything drifted, so `--check` never leaves the tree altered.
        await restoreSnapshot(driftBefore, after);

        if (drift.length) {
          console.error(chalk.red(`\nGenerated output is out of date (${drift.length} file(s)):`));
          for (const d of drift) {
            const mark = d.status === 'added' ? '+' : d.status === 'removed' ? '-' : '~';
            console.error(
              `  ${mark} ${chalk.yellow(d.status.padEnd(8))} ${path.relative(process.cwd(), d.file)}`
            );
          }
          console.error(
            chalk.dim(
              '\nRun `drzl generate` and commit the result. Nothing was written by this check.'
            )
          );
          process.exit(1);
        }
        console.log(chalk.green('Generated output is up to date.'));
        return;
      }

      if (cfg.generators.length) {
        maybeShowSponsorMessage({ reason: 'generate' });
      }
    } catch (e: any) {
      console.error(
        chalk.red('Generate failed (DRZL_GEN_001):'),
        e?.message ?? e,
        '\nTip: check your drzl.config.ts and template path.'
      );
      process.exit(1);
    }
  });

program
  .command('generate:orpc')
  .argument('<schema>', 'path to drizzle schema (TS)')
  .option('-o, --outDir <dir>', 'output directory', 'src/api')
  .option('--template <name>', 'template name', 'standard')
  .option('--includeRelations', 'include relation endpoints')
  .action(async (schema: string, opts: any) => {
    try {
      const analyzer = new SchemaAnalyzer(schema);
      const analysis = await analyzer.analyze({
        includeRelations: !!opts.includeRelations,
        validateConstraints: true,
      });
      const gen = new ORPCGenerator(analysis);
      const { files } = await gen.generate({
        outputDir: opts.outDir,
        template: opts.template,
        includeRelations: !!opts.includeRelations,
      });
      console.log(chalk.green(`Generated:`), files.map((f) => chalk.cyan(f)).join(', '));
      maybeShowSponsorMessage({ reason: 'generate:orpc' });
    } catch (e: any) {
      console.error(chalk.red('Generate orpc failed:'), e?.message ?? e);
      process.exit(1);
    }
  });

program
  .command('watch')
  .description('Watch schema and regenerate on changes')
  .option('-c, --config <path>', 'path to drzl.config')
  .option('--pipeline <name>', 'all | analyze | generate-orpc', 'all')
  .option('--debounce <ms>', 'debounce ms', '200')
  .option('--json', 'emit JSON logs', false)
  .option('--poll', 'force polling (helps WSL/Docker/remote FS)', false)
  .action(async (opts: any) => {
    let cfg = await loadConfig(opts.config);
    if (!cfg) {
      console.error(chalk.red('No config found. Create drzl.config.ts or pass --config.'));
      process.exit(2);
      return;
    }

    const abs = (p: string) => path.resolve(process.cwd(), p);
    const isInside = (child: string, parent: string) => {
      const rel = path.relative(parent, child);
      return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
    };

    const ignoredOutDirs = new Set<string>(computeGeneratorOutputDirs(cfg).map(abs));
    const currentTargets = new Set<string>(computeWatchTargets(cfg).map(abs));

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
      if (opts.json) console.log(JSON.stringify({ event: 'trigger', type, file }));
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

    const run = async () => {
      try {
        const reloaded = await loadConfig(opts.config);
        if (!reloaded) throw new Error('Config disappeared during watch.');
        cfg = reloaded;

        rebuildIgnoreDirsFrom(cfg);
        const nextTargets = new Set<string>(computeWatchTargets(cfg).map(abs));
        syncWatcherTargets(watcher, nextTargets);

        if (!opts.json) console.clear();

        if (opts.json) {
          console.log(
            JSON.stringify({
              event: 'watch_config_applied',
              targets: Array.from(currentTargets),
              ignored: Array.from(ignoredOutDirs),
            })
          );
        }

        const analyzer = new SchemaAnalyzer(cfg.schema);
        const analysis = await analyzer.analyze({
          includeRelations: cfg.analyzer.includeRelations,
          validateConstraints: cfg.analyzer.validateConstraints,
          includeHeuristicRelations: cfg.analyzer.includeHeuristicRelations,
        });
        analysis.tables = filterTables(analysis.tables, cfg);
        if (!opts.json) reportWideColumns(analysis.issues);

        if (opts.pipeline === 'analyze') {
          if (opts.json) {
            console.log(
              JSON.stringify({
                event: 'analyze_complete',
                issues: analysis.issues,
                tables: analysis.tables.length,
              })
            );
          } else {
            console.log(chalk.green('Analyze complete.'));
          }
          return;
        }

        const newFiles: string[] = [];

        for (const g of cfg.generators) {
          if (
            opts.pipeline !== 'all' &&
            !(opts.pipeline === 'generate-orpc' && g.kind === 'orpc')
          ) {
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
            });
            opts.json
              ? console.log(JSON.stringify({ event: 'generate_complete', kind: g.kind, files }))
              : console.log(
                  chalk.green(`Generated (${g.kind}):`),
                  files.map((f: string) => chalk.cyan(f)).join(', ')
                );
            newFiles.push(...files);
          } else if (g.kind === 'service') {
            try {
              const { ServiceGenerator } = await import('@drzl/generator-service');
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
              });
              opts.json
                ? console.log(JSON.stringify({ event: 'generate_complete', kind: g.kind, files }))
                : console.log(
                    chalk.green(`Generated (service): ${files.length} files`),
                    files.map((f: string) => chalk.cyan(f)).join(', ')
                  );
              newFiles.push(...files);
            } catch (e: any) {
              console.error(
                chalk.red('Service generator missing.'),
                chalk.yellow('\nInstall with: npm install @drzl/generator-service')
              );
              console.error(chalk.gray('Error details:'), e?.message ?? e);
              return;
            }
          } else if (g.kind === 'zod') {
            try {
              const { ZodGenerator } = await import('@drzl/generator-zod');
              const gen = new ZodGenerator(analysis);
              const target = g.path ?? 'src/validators/zod';
              const files = await gen.generate({
                outDir: target,
                outputHeader: g.outputHeader,
                format: g.format,
                schemaSuffix: g.schemaSuffix,
                fileSuffix: g.fileSuffix,
                importExtension: g.importExtension,
                affix: g.affix,
              });
              opts.json
                ? console.log(JSON.stringify({ event: 'generate_complete', kind: g.kind, files }))
                : console.log(
                    chalk.green(`Generated (zod): ${files.length} files`),
                    files.map((f: string) => chalk.cyan(f)).join(', ')
                  );
              newFiles.push(...files);
            } catch (e: any) {
              console.error(
                chalk.red('Zod generator missing.'),
                chalk.yellow('\nInstall with: npm install @drzl/generator-zod')
              );
              console.error(chalk.gray('Error details:'), e?.message ?? e);
              return;
            }
          } else if (g.kind === 'valibot') {
            try {
              const { ValibotGenerator } = await import('@drzl/generator-valibot');
              const gen = new ValibotGenerator(analysis);
              const target = g.path ?? 'src/validators/valibot';
              const files = await gen.generate({
                outDir: target,
                outputHeader: g.outputHeader,
                format: g.format,
                schemaSuffix: g.schemaSuffix,
                fileSuffix: g.fileSuffix,
                importExtension: g.importExtension,
                affix: g.affix,
              });
              opts.json
                ? console.log(JSON.stringify({ event: 'generate_complete', kind: g.kind, files }))
                : console.log(
                    chalk.green(`Generated (valibot): ${files.length} files`),
                    files.map((f: string) => chalk.cyan(f)).join(', ')
                  );
              newFiles.push(...files);
            } catch (e: any) {
              console.error(
                chalk.red('Valibot generator missing.'),
                chalk.yellow('\nInstall with: npm install @drzl/generator-valibot')
              );
              console.error(chalk.gray('Error details:'), e?.message ?? e);
              return;
            }
          } else if (g.kind === 'arktype') {
            try {
              const { ArkTypeGenerator } = await import('@drzl/generator-arktype');
              const gen = new ArkTypeGenerator(analysis);
              const target = g.path ?? 'src/validators/arktype';
              const files = await gen.generate({
                outDir: target,
                outputHeader: g.outputHeader,
                format: g.format,
                schemaSuffix: g.schemaSuffix,
                fileSuffix: g.fileSuffix,
                importExtension: g.importExtension,
                affix: g.affix,
              });
              opts.json
                ? console.log(JSON.stringify({ event: 'generate_complete', kind: g.kind, files }))
                : console.log(
                    chalk.green(`Generated (arktype): ${files.length} files`),
                    files.map((f: string) => chalk.cyan(f)).join(', ')
                  );
              newFiles.push(...files);
            } catch (e: any) {
              console.error(
                chalk.red('ArkType generator missing.'),
                chalk.yellow('\nInstall with: npm install @drzl/generator-arktype')
              );
              console.error(chalk.gray('Error details:'), e?.message ?? e);
              return;
            }
          }
        }

        const added = newFiles.filter((f) => !lastFiles.includes(f));
        const removed = lastFiles.filter((f) => !newFiles.includes(f));
        opts.json
          ? console.log(JSON.stringify({ event: 'diff', added, removed }))
          : (() => {
              if (added.length) console.log(chalk.blue(`Added: ${added.join(', ')}`));
              if (removed.length) console.log(chalk.yellow(`Removed: ${removed.join(', ')}`));
            })();
        if (newFiles.length && !opts.json) {
          const reason =
            opts.pipeline && opts.pipeline !== 'all' ? `watch:${opts.pipeline}` : 'watch';
          maybeShowSponsorMessage({ reason });
        }
        lastFiles = newFiles;
      } catch (e: any) {
        opts.json
          ? console.log(JSON.stringify({ event: 'error', message: String(e?.message ?? e) }))
          : console.error(chalk.red('Watch pipeline failed:'), e?.message ?? e);
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
      console.log(
        JSON.stringify({
          event: 'watching',
          targets: Array.from(currentTargets),
          ignored: Array.from(ignoredOutDirs),
        })
      );
    } else {
      console.log(
        chalk.gray(
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
      .on('error', (err) => console.error(chalk.red('Watcher error:'), err));

    await run();
  });

program
  .command('init')
  .description('Scaffold a drzl.config.ts')
  .option('-y, --yes', 'accept defaults')
  .action(async (_opts: any) => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const target = path.resolve(process.cwd(), 'drzl.config.ts');
    const template = `export default {
  schema: 'src/db/schema.ts',
  outDir: 'src/api',
  analyzer: { includeRelations: true, validateConstraints: true },
  generators: [
    { kind: 'orpc', template: 'standard', includeRelations: true }
  ]
} as const\n`;
    try {
      await fs.writeFile(target, template, { flag: 'wx' });
      console.log(chalk.green(`Created ${target}`));
    } catch (e: any) {
      console.error(chalk.red('Init failed:'), e?.message ?? e);
      process.exit(1);
    }
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
function reportWideColumns(issues: Array<{ code?: string; message?: string; hint?: string }>) {
  const wide = issues.filter((i) => i.code === 'DRZL_ANL_UNKNOWN_COLUMN');
  if (!wide.length) return;
  console.warn(
    chalk.yellow(`\n${wide.length} column${wide.length === 1 ? '' : 's'} could not be typed:`)
  );
  for (const i of wide.slice(0, 10)) console.warn(chalk.gray(`  - ${i.message}`));
  if (wide.length > 10) console.warn(chalk.gray(`  ... and ${wide.length - 10} more`));
  // One hint for the set, since they are almost always the same two.
  const hints = [...new Set(wide.map((i) => i.hint).filter(Boolean))];
  for (const h of hints) console.warn(chalk.gray(`  ${h}`));
}

program.parseAsync(process.argv);
