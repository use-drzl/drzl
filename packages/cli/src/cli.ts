#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import cliProgress from 'cli-progress';
import { loadConfig } from './config.js';
import { SchemaAnalyzer } from '@drzl/analyzer';
import { ORPCGenerator } from '@drzl/generator-orpc';
import chokidar from 'chokidar';

const program = new Command();
program.name('drzl').description('DRZL - Drizzle Developer Toolkit').version('0.0.1');

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
      spinner.succeed(`Analysis complete in ${Date.now() - t0}ms`);
      const progress = new cliProgress.SingleBar(
        { hideCursor: true },
        cliProgress.Presets.shades_classic
      );
      const total = analysis.tables.length || 1;
      progress.start(total, 0);
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
            validation: g.validation,
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
            });
            progress.stop();
            ora().succeed(chalk.green(`Generated (service): ${files.length} files`));
            files.forEach((f: string) => console.log('  -', chalk.cyan(f)));
          } catch (e: any) {
            progress.stop();
            console.error(
              chalk.red('Service generator missing (install @drzl/generator-service)?'),
              e?.message ?? e
            );
            process.exit(1);
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
            });
            progress.stop();
            ora().succeed(chalk.green(`Generated (zod): ${files.length} files`));
            files.forEach((f: string) => console.log('  -', chalk.cyan(f)));
          } catch (e: any) {
            progress.stop();
            console.error(
              chalk.red('Zod generator missing (install @drzl/generator-zod)?'),
              e?.message ?? e
            );
            process.exit(1);
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
            });
            progress.stop();
            ora().succeed(chalk.green(`Generated (valibot): ${files.length} files`));
            files.forEach((f: string) => console.log('  -', chalk.cyan(f)));
          } catch (e: any) {
            progress.stop();
            console.error(
              chalk.red('Valibot generator missing (install @drzl/generator-valibot)?'),
              e?.message ?? e
            );
            process.exit(1);
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
            });
            progress.stop();
            ora().succeed(chalk.green(`Generated (arktype): ${files.length} files`));
            files.forEach((f: string) => console.log('  -', chalk.cyan(f)));
          } catch (e: any) {
            progress.stop();
            console.error(
              chalk.red('ArkType generator missing (install @drzl/generator-arktype)?'),
              e?.message ?? e
            );
            process.exit(1);
          }
        }
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
  .action(async (opts: any) => {
    const cfg = await loadConfig(opts.config);
    if (!cfg) {
      console.error(chalk.red('No config found. Create drzl.config.ts or pass --config.'));
      process.exit(2);
      return;
    }
    let lastFiles: string[] = [];
    const run = async () => {
      try {
        if (!opts.json) console.clear();
        const analyzer = new SchemaAnalyzer(cfg.schema);
        const analysis = await analyzer.analyze({
          includeRelations: cfg.analyzer.includeRelations,
          validateConstraints: cfg.analyzer.validateConstraints,
        });
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
          if (g.kind === 'orpc' && (opts.pipeline === 'all' || opts.pipeline === 'generate-orpc')) {
            const gen = new ORPCGenerator(analysis);
            const { files } = await gen.generate({
              outputDir: cfg.outDir,
              template: g.template,
              includeRelations: g.includeRelations,
              naming: g.naming,
            });
            if (opts.json) {
              console.log(JSON.stringify({ event: 'generate_complete', kind: g.kind, files }));
            } else {
              console.log(
                chalk.green(`Generated (${g.kind}):`),
                files.map((f: string) => chalk.cyan(f)).join(', ')
              );
            }
            newFiles.push(...files);
          }
        }
        // Diff
        const added = newFiles.filter((f) => !lastFiles.includes(f));
        const removed = lastFiles.filter((f) => !newFiles.includes(f));
        if (opts.json) {
          console.log(JSON.stringify({ event: 'diff', added, removed }));
        } else {
          if (added.length) console.log(chalk.blue(`Added: ${added.join(', ')}`));
          if (removed.length) console.log(chalk.yellow(`Removed: ${removed.join(', ')}`));
        }
        lastFiles = newFiles;
      } catch (e: any) {
        if (opts.json)
          console.log(JSON.stringify({ event: 'error', message: String(e?.message ?? e) }));
        else console.error(chalk.red('Watch pipeline failed:'), e?.message ?? e);
      }
    };
    const debounced = Number(opts.debounce) || 200;
    let timer: any = null;
    const trigger = (file?: string) => {
      // Ignore changes in outDir to avoid loops
      if (file && file.startsWith(cfg.outDir)) return;
      clearTimeout(timer);
      timer = setTimeout(run, debounced);
    };
    console.log(chalk.gray('Watching for changes...'));
    const watchSet = new Set<string>([cfg.schema]);
    // Watch template paths (only when path-like and exists)
    for (const g of cfg.generators) {
      if (g.template && g.template !== 'standard' && g.template !== 'minimal') {
        watchSet.add(g.template);
      }
    }
    // Also watch outDir but ignore events from it to report diffs cleanly
    watchSet.add(cfg.outDir);
    chokidar
      .watch(Array.from(watchSet), { ignoreInitial: true })
      .on('add', (p) => trigger(p))
      .on('change', (p) => trigger(p))
      .on('unlink', (p) => trigger(p));
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

program.parseAsync(process.argv);
