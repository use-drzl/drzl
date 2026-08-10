/**
 * `drzl init`, unit level: the detection rule, the generator list, the rendered config, and the
 * prompt loop driven over ordinary pipes (items 65, 66, 67).
 *
 * The prompt functions take their streams as parameters precisely so this file can drive them.
 * A pseudo-terminal is the one thing a portable test cannot conjure, so the split is deliberate:
 * `isInteractive` is the only code that reads `isTTY`, and it is tested here against fake
 * descriptors, while `promptForPlan` is tested over real streams and never learns whether they
 * are terminals. Between the two there is nothing left for a pty to prove.
 */
import { PassThrough } from 'node:stream';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  classifySchemaCandidate,
  DEFAULT_GENERATOR_KIND,
  detectSchema,
  INIT_GENERATOR_CHOICES,
  isInteractive,
  normalizeGenerators,
  parseGeneratorsFlag,
  promptForPlan,
  renderInitConfig,
  runInit,
  schemaCandidates,
} from '../src/init';

const ROOT = path.join(__dirname, '.tmp-init-unit');

const SCHEMA = `
import { pgTable, serial, text } from 'drizzle-orm/pg-core';
export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  email: text('email').notNull(),
});
`;

async function make(name: string, files: Record<string, string> = {}) {
  const dir = path.join(ROOT, name);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(dir, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, body, 'utf8');
  }
  return dir;
}

/** Collects what a command printed, so an assertion can be made about it. */
function recorder() {
  const lines: string[] = [];
  return { lines, sink: (s: string) => lines.push(s), text: () => lines.join('\n') };
}

beforeAll(async () => {
  await fs.mkdir(ROOT, { recursive: true });
});

afterAll(async () => {
  await fs.rm(ROOT, { recursive: true, force: true });
});

describe('the generators init offers (66)', () => {
  it('offers only kinds @drzl/cli depends on outright', async () => {
    // The floor under the scaffold: a config `init` writes never names a package the CLI does
    // not bring with it. It used to be the filter as well, when eight generators sat in
    // `optionalDependencies` an installer skips and a config naming one would fail its first
    // `generate` on a module that was never installed. All fourteen are hard dependencies now, so
    // every kind clears this and what keeps the list at five is `renderInitConfig`, which knows
    // two entry shapes. Asserted against package.json rather than restated, so moving a generator
    // between the two lists moves this test with it.
    const pkg = JSON.parse(
      await fs.readFile(path.join(__dirname, '..', 'package.json'), 'utf8')
    ) as {
      dependencies: Record<string, string>;
      optionalDependencies: Record<string, string>;
    };
    for (const choice of INIT_GENERATOR_CHOICES) {
      expect(pkg.dependencies, `${choice.kind} must be a hard dependency`).toHaveProperty(
        choice.packageName
      );
      expect(pkg.optionalDependencies ?? {}).not.toHaveProperty(choice.packageName);
    }
  });

  it('defaults to a validator, not a router', () => {
    expect(DEFAULT_GENERATOR_KIND).toBe('zod');
    expect(INIT_GENERATOR_CHOICES[0].kind).toBe('zod');
  });

  it('refuses a kind it cannot scaffold, naming the ones it can', () => {
    expect(() => normalizeGenerators(['trpc'])).toThrow(/not a generator init can scaffold/);
    // The message has to carry the alternatives, or the error is a dead end.
    expect(() => normalizeGenerators(['trpc'])).toThrow(/zod/);
  });

  it('deduplicates and orders what it is given', () => {
    expect(normalizeGenerators(['orpc', 'zod', 'orpc'])).toEqual(['zod', 'orpc']);
    expect(normalizeGenerators(undefined)).toBeUndefined();
    expect(parseGeneratorsFlag('zod, orpc')).toEqual(['zod', 'orpc']);
    expect(parseGeneratorsFlag(undefined)).toBeUndefined();
    expect(() => parseGeneratorsFlag(' , ')).toThrow(/no kinds/);
  });
});

describe('classifying a candidate by loading it (67)', () => {
  it('confirms a file that declares drizzle tables', async () => {
    const dir = await make('classify-good', { 'src/db/schema.ts': SCHEMA });
    const report = await classifySchemaCandidate(path.join(dir, 'src/db/schema.ts'));
    expect(report.verdict).toBe('confirmed');
    expect(report.tables).toBe(1);
  }, 30_000);

  it('rejects a file that imports cleanly and declares none', async () => {
    // The case that makes existence useless as a test. This file is named `schema.ts`, sits at
    // the most conventional path there is, and is not a schema.
    const dir = await make('classify-empty', {
      'src/db/schema.ts': 'export const DB_URL = "x";\n',
    });
    const report = await classifySchemaCandidate(path.join(dir, 'src/db/schema.ts'));
    expect(report.verdict).toBe('rejected');
  }, 30_000);

  it('leaves a file it could not import unverified rather than rejected', async () => {
    // Almost always "install has not been run yet". Rejecting it would send a user with a
    // perfectly good schema down the no-schema path, so it is adopted with a warning instead.
    const dir = await make('classify-broken', {
      'src/db/schema.ts': `import { x } from 'no-such-package-anywhere';\nexport const t = x;\n`,
    });
    const report = await classifySchemaCandidate(path.join(dir, 'src/db/schema.ts'));
    expect(report.verdict).toBe('unverified');
    expect(report.reason).toBeTruthy();
  }, 30_000);

  it('treats a missing file as rejected, not as a crash', async () => {
    const dir = await make('classify-missing');
    const report = await classifySchemaCandidate(path.join(dir, 'nope.ts'));
    expect(report.verdict).toBe('rejected');
  }, 30_000);
});

describe('detection order (67)', () => {
  it('prefers the drizzle-kit config over a conventional path', async () => {
    // Both are present and they disagree. The kit config is a statement the user wrote; the
    // conventional path is a guess, so the statement wins.
    const dir = await make('detect-kit-wins', {
      'src/db/schema.ts': SCHEMA,
      'db/tables/all.ts': SCHEMA,
      'drizzle.config.ts': `export default { dialect: 'postgresql', schema: './db/tables/*.ts' };\n`,
    });
    const detection = await detectSchema(dir);
    expect(detection.source).toBe('drizzle-kit');
    // Nothing is written into `schema`: the kit config is read at generate time, so the path
    // stays stated exactly once.
    expect(detection.schema).toBeUndefined();
    expect(detection.tables).toBe(1);
  }, 30_000);

  it('falls back to the conventional walk when the kit config names no tables', async () => {
    const dir = await make('detect-kit-empty', {
      'src/db/schema.ts': SCHEMA,
      'db/tables/all.ts': 'export const nothing = 1;\n',
      'drizzle.config.ts': `export default { dialect: 'postgresql', schema: './db/tables/*.ts' };\n`,
    });
    const detection = await detectSchema(dir);
    expect(detection.source).toBe('convention');
    expect(detection.schema).toBe('src/db/schema.ts');
  }, 30_000);

  it('walks past a conventional path that declares no tables to one that does', async () => {
    // `src/db/schema.ts` comes first in the candidate order and is not a schema; the one further
    // down is. Existence-based detection stops at the first and produces a config that analyzes
    // nothing.
    const dir = await make('detect-walk-past', {
      'src/db/schema.ts': 'export const notASchema = true;\n',
      'src/lib/db/schema.ts': SCHEMA,
    });
    const detection = await detectSchema(dir);
    expect(detection.schema).toBe('src/lib/db/schema.ts');
    expect(detection.verdict).toBe('confirmed');
  }, 60_000);

  it('prefers a confirmed candidate over an unverified one earlier in the order', async () => {
    const dir = await make('detect-confirmed-wins', {
      'src/db/schema.ts': `import { x } from 'no-such-package-anywhere';\nexport const t = x;\n`,
      'src/schema.ts': SCHEMA,
    });
    const detection = await detectSchema(dir);
    expect(detection.schema).toBe('src/schema.ts');
    expect(detection.verdict).toBe('confirmed');
  }, 60_000);

  it('reports none when there is nothing, rather than inventing a path', async () => {
    const dir = await make('detect-none');
    const detection = await detectSchema(dir);
    expect(detection.source).toBe('none');
    expect(detection.schema).toBeUndefined();
  }, 30_000);

  it('lists every candidate as a real relative path with a schema-shaped name', () => {
    const candidates = schemaCandidates();
    expect(candidates[0]).toBe('src/db/schema.ts');
    expect(new Set(candidates).size).toBe(candidates.length);
    for (const c of candidates) {
      expect(path.isAbsolute(c)).toBe(false);
      // Importing a candidate is how it is validated, so the list must not contain a module that
      // might open a connection rather than declare tables.
      expect(c.replace(/\.(ts|js)$/, '').replace(/\/index$/, '')).toMatch(/(schema|schemas)$/);
    }
  });
});

describe('the config it renders', () => {
  it('keeps the type-only import and the satisfies (item 64)', () => {
    const out = renderInitConfig({
      schema: 'a.ts',
      schemaSource: 'convention',
      generators: ['zod'],
    });
    expect(out).toContain("import type { DrzlConfigInput } from '@drzl/cli/config'");
    expect(out).toContain('satisfies DrzlConfigInput');
    // A value import would be executed by jiti and would fail under `npx` in a project with no
    // local @drzl/cli. `import type` is erased first, which is the only reason the scaffold runs
    // there at all.
    expect(out).not.toContain('import { defineConfig }');
  });

  it('states no schema key when there is no schema to name', () => {
    const none = renderInitConfig({ schemaSource: 'none', generators: ['zod'] });
    expect(none).not.toMatch(/^ {2}schema:/m);
    expect(none).toContain("// schema: 'src/db/schema.ts'");
    const kit = renderInitConfig({ schemaSource: 'drizzle-kit', generators: ['zod'] });
    expect(kit).not.toMatch(/^ {2}schema:/m);
    expect(kit).toContain('drizzle-kit config');
  });

  it('only carries outDir when something writes routers into it', () => {
    const validators = renderInitConfig({ schemaSource: 'none', generators: ['zod'] });
    expect(validators).not.toContain('outDir');
    const router = renderInitConfig({ schemaSource: 'none', generators: ['orpc'] });
    expect(router).toContain(`outDir: 'src/api'`);
  });
});

describe('deciding whether to ask (65)', () => {
  const env = {} as Record<string, string | undefined>;

  it('asks only when both streams are terminals', () => {
    expect(isInteractive({ stdin: { isTTY: true }, stdout: { isTTY: true }, env })).toBe(true);
    expect(isInteractive({ stdin: { isTTY: false }, stdout: { isTTY: true }, env })).toBe(false);
    // A question printed down a redirected stdout is invisible, so waiting for its answer is a
    // hang from the point of view of whoever is looking at the terminal.
    expect(isInteractive({ stdin: { isTTY: true }, stdout: { isTTY: false }, env })).toBe(false);
    expect(isInteractive({ stdin: {}, stdout: {}, env })).toBe(false);
  });

  it('never asks under CI, even on a pty', () => {
    // Some runners do allocate one. A hung `init` in a pipeline is worse than the defect that
    // prompts were added to fix.
    expect(
      isInteractive({ stdin: { isTTY: true }, stdout: { isTTY: true }, env: { CI: 'true' } })
    ).toBe(false);
  });
});

describe('the prompt loop, over ordinary pipes (65)', () => {
  /** Drive `promptForPlan` with scripted answers, one per question asked. */
  async function drive(
    args: Omit<Parameters<typeof promptForPlan>[0], 'input' | 'output'>,
    answers: string[]
  ) {
    const input = new PassThrough();
    const output = new PassThrough();
    let printed = '';
    output.on('data', (d) => {
      printed += d.toString();
    });
    const done = promptForPlan({ ...args, input, output });
    for (const a of answers) {
      await new Promise((r) => setTimeout(r, 25));
      input.write(a + '\n');
    }
    const result = await done;
    return { result, printed };
  }

  const detected = {
    source: 'convention' as const,
    schema: 'src/db/schema.ts',
    verdict: 'confirmed' as const,
    tables: 2,
    notes: ['Schema found at src/db/schema.ts (2 tables)'],
  };

  it('takes the detected schema and zod when both answers are empty', async () => {
    const { result, printed } = await drive({ detection: detected, cwd: ROOT }, ['', '']);
    expect(result.schema).toBe('src/db/schema.ts');
    expect(result.generators).toEqual(['zod']);
    expect(printed).toContain('Schema file [src/db/schema.ts]');
    expect(printed).toContain('1) Zod validators');
  }, 30_000);

  it('takes a typed schema path and a numbered generator', async () => {
    const dir = await make('prompt-typed', { 'src/database/tables.ts': SCHEMA });
    const { result } = await drive({ detection: detected, cwd: dir }, [
      'src/database/tables.ts',
      '5',
    ]);
    expect(result.schema).toBe('src/database/tables.ts');
    expect(result.generators).toEqual(['orpc']);
  }, 30_000);

  it('accepts a generator by name as well as by number', async () => {
    const { result } = await drive({ detection: detected, cwd: ROOT }, ['', 'valibot']);
    expect(result.generators).toEqual(['valibot']);
  }, 30_000);

  it('re-asks a choice that is not on the list, then falls back rather than looping', async () => {
    const { result, printed } = await drive({ detection: detected, cwd: ROOT }, [
      '',
      'prisma',
      'nonsense',
      'still-no',
    ]);
    expect(printed).toContain('"prisma" is not one of the choices.');
    expect(result.generators).toEqual(['zod']);
  }, 30_000);

  it('skips the question a flag already answered', async () => {
    // Only one answer is scripted, and it is consumed by the generator question, which proves
    // the schema question was never asked.
    const { result, printed } = await drive(
      { detection: detected, cwd: ROOT, schemaFromFlag: 'given/by/flag.ts' },
      ['3']
    );
    expect(printed).not.toContain('Schema file');
    expect(result.schema).toBe('given/by/flag.ts');
    expect(result.generators).toEqual(['arktype']);
  }, 30_000);

  it('asks nothing at all when both flags are given', async () => {
    const { result, printed } = await drive(
      {
        detection: detected,
        cwd: ROOT,
        schemaFromFlag: 'given/by/flag.ts',
        generatorsFromFlag: ['zod', 'orpc'],
      },
      []
    );
    expect(printed).toBe('');
    expect(result.generators).toEqual(['zod', 'orpc']);
  }, 30_000);

  it('takes the defaults and stops when the input ends mid-question', async () => {
    // The Ctrl+D case, and the only thing standing between a prompt and an unkillable CI job.
    const input = new PassThrough();
    const output = new PassThrough();
    const done = promptForPlan({ input, output, detection: detected, cwd: ROOT });
    setTimeout(() => input.end(), 30);
    const result = await done;
    expect(result.endedEarly).toBe(true);
    expect(result.schema).toBe('src/db/schema.ts');
    expect(result.generators).toEqual(['zod']);
  }, 30_000);
});

describe('runInit as a whole', () => {
  it('writes nothing and reports the file when a config is already there', async () => {
    const dir = await make('run-existing', { 'drzl.config.ts': '// mine\n' });
    const log = recorder();
    const err = recorder();
    const outcome = await runInit({
      cwd: dir,
      yes: true,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      env: {},
      log: log.sink,
      error: err.sink,
    });
    expect(outcome.code).toBe(1);
    expect(outcome.written).toBeUndefined();
    expect(await fs.readFile(path.join(dir, 'drzl.config.ts'), 'utf8')).toBe('// mine\n');
    expect(err.text()).toContain('drzl.config.ts');
    expect(err.text()).toContain('never overwrites');
    // The old message was the raw errno string, which named no command and suggested nothing.
    expect(err.text()).not.toContain('EEXIST');
  }, 30_000);

  it('asks nothing under --yes even when both streams are terminals', async () => {
    const dir = await make('run-yes-on-tty', { 'src/db/schema.ts': SCHEMA });
    const stdin = Object.assign(new PassThrough(), { isTTY: true });
    const stdout = Object.assign(new PassThrough(), { isTTY: true });
    let printed = '';
    stdout.on('data', (d) => {
      printed += d.toString();
    });
    const log = recorder();
    const outcome = await runInit({
      cwd: dir,
      yes: true,
      stdin,
      stdout,
      env: {},
      log: log.sink,
      error: log.sink,
    });
    expect(outcome.code).toBe(0);
    // Nothing was written to the terminal stream: every line went to `log`, and no question was
    // asked. If `--yes` ever stopped short-circuiting, this test would time out instead.
    expect(printed).toBe('');
    expect(outcome.plan?.generators).toEqual(['zod']);
    expect(outcome.plan?.schema).toBe('src/db/schema.ts');
  }, 30_000);

  it('rejects an unknown --generators kind before touching the disk', async () => {
    const dir = await make('run-bad-generators', { 'src/db/schema.ts': SCHEMA });
    const err = recorder();
    const outcome = await runInit({
      cwd: dir,
      yes: true,
      generatorsFlag: 'zod,hono',
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      env: {},
      log: () => {},
      error: err.sink,
    });
    expect(outcome.code).toBe(1);
    await expect(fs.readFile(path.join(dir, 'drzl.config.ts'), 'utf8')).rejects.toThrow();
    expect(err.text()).toContain('hono');
  }, 30_000);

  it('uses --schema verbatim and says so when it declares no tables', async () => {
    const dir = await make('run-schema-flag', { 'weird/place.ts': 'export const x = 1;\n' });
    const log = recorder();
    const outcome = await runInit({
      cwd: dir,
      yes: true,
      schemaFlag: 'weird/place.ts',
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      env: {},
      log: log.sink,
      error: log.sink,
    });
    expect(outcome.code).toBe(0);
    expect(outcome.plan?.schema).toBe('weird/place.ts');
    // An explicit flag is obeyed, because the user may be scaffolding before writing the schema.
    // Silence would be the defect; the line is what stops it being silent.
    expect(log.text()).toContain('declares no Drizzle tables');
  }, 30_000);

  it('says so when --schema names a file that is not there', async () => {
    const dir = await make('run-schema-flag-missing');
    const log = recorder();
    const outcome = await runInit({
      cwd: dir,
      yes: true,
      schemaFlag: 'src/db/not-written-yet.ts',
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      env: {},
      log: log.sink,
      error: log.sink,
    });
    expect(outcome.code).toBe(0);
    expect(outcome.plan?.schema).toBe('src/db/not-written-yet.ts');
    // "declares no Drizzle tables" would be the wrong sentence about a file that does not exist,
    // and it is the one the analyzer's verdict alone would produce.
    expect(log.text()).toContain('is not there yet');
  }, 30_000);
});
