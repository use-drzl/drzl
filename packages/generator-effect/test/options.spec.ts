/**
 * The options every validation generator carries, exercised through the emitted module.
 *
 * `applyDefaults`, `coerceDates`, `duplicateFinder`, affixes, `fileSuffix` and the barrel. These
 * are the ones the CLI builds per branch, and the ones a drifted `watch` branch drops silently, so
 * each is checked by generating with it and running the result.
 */
import { afterAll, describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { EffectGenerator } from '../src/index';
import {
  accepts,
  analysisOf,
  col,
  decoded,
  emit,
  emitColumn,
  emitText,
  table,
  workDir,
} from './fixtures';

/** Directories these cases drive the generator into by hand, removed once they have been read. */
const made: string[] = [];
const scratch = async () => {
  const dir = await workDir();
  made.push(dir);
  return dir;
};
afterAll(async () => {
  await Promise.all(made.map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe('applyDefaults', () => {
  it('is off by default, so parsing returns what it was given', async () => {
    const m = await emitColumn(col('country', { hasDefault: true, defaultValue: 'GB' }));
    expect(decoded(m.InserttSchema, {})).toEqual({});
  });

  it('fills a literal default in on insert when asked', async () => {
    const m = await emitColumn(col('country', { hasDefault: true, defaultValue: 'GB' }), [], {
      applyDefaults: true,
    });
    expect(decoded(m.InserttSchema, {})).toEqual({ country: 'GB' });
    expect(decoded(m.InserttSchema, { country: 'US' })).toEqual({ country: 'US' });
  });

  it('never fills one in on update, where an absent key means do not touch it', async () => {
    const m = await emitColumn(col('country', { hasDefault: true, defaultValue: 'GB' }), [], {
      applyDefaults: true,
    });
    expect(decoded(m.UpdatetSchema, {})).toEqual({});
  });

  it('leaves a column whose default the database evaluates alone', async () => {
    // `defaultNow()` sets `hasDefault` and carries no `defaultValue`, so there is nothing to
    // reproduce and the key is merely optional.
    const m = await emitColumn(
      col('createdAt', { tsType: 'Date', dbType: 'TIMESTAMP', hasDefault: true }),
      [],
      { applyDefaults: true }
    );
    expect(decoded(m.InserttSchema, {})).toEqual({});
  });
});

describe('coerceDates', () => {
  const dateCol = col('at', { tsType: 'Date', dbType: 'TIMESTAMP' });

  it('defaults to coercing on the write modes and not on select', async () => {
    const m = await emitColumn(dateCol);
    expect(accepts(m.InserttSchema, { at: '2020-01-01' })).toBe(true);
    expect(accepts(m.SelecttSchema, { at: '2020-01-01' }), 'a select returns a Date').toBe(false);
    expect(accepts(m.SelecttSchema, { at: new Date(0) })).toBe(true);
  });

  it("takes a string on every mode under 'all'", async () => {
    const m = await emitColumn(dateCol, [], { coerceDates: 'all' });
    expect(accepts(m.SelecttSchema, { at: '2020-01-01' })).toBe(true);
  });

  it("takes only a Date under 'none'", async () => {
    const m = await emitColumn(dateCol, [], { coerceDates: 'none' });
    expect(accepts(m.InserttSchema, { at: '2020-01-01' })).toBe(false);
    expect(accepts(m.InserttSchema, { at: new Date(0) })).toBe(true);
  });

  it('refuses a string the two parsers would disagree about', async () => {
    const m = await emitColumn(dateCol);
    // Postgres reads '250101' as 2025-01-01 and V8 as the year 250101. Neither answer is safe.
    expect(accepts(m.InserttSchema, { at: '250101' })).toBe(false);
    expect(accepts(m.InserttSchema, { at: '12.5' })).toBe(false);
    expect(accepts(m.InserttSchema, { at: '+2020-01-01' })).toBe(false);
  });

  it('refuses a string that passes the shape gate and is still not a date', async () => {
    const m = await emitColumn(dateCol);
    for (const bad of ['hello', 'zzz', '25:99:99', '12:00:00', 'not-a-uuid']) {
      expect(accepts(m.InserttSchema, { at: bad }), bad).toBe(false);
    }
    for (const good of ['2020-01-01', '2020-01-01T00:00:00Z', 'January 8, 1999', '01/02/2020']) {
      expect(accepts(m.InserttSchema, { at: good }), good).toBe(true);
    }
  });

  it('takes an epoch number and refuses one past the Date range', async () => {
    const m = await emitColumn(dateCol);
    expect(accepts(m.InserttSchema, { at: Date.now() })).toBe(true);
    expect(accepts(m.InserttSchema, { at: 1e300 }), 'a good number and not a date').toBe(false);
  });
});

describe('naming', () => {
  it('honours a schema suffix', async () => {
    const m = await emit(analysisOf([table('t', [col('n')])]), { schemaSuffix: 'Validator' });
    expect(m.SelecttValidator).toBeDefined();
    expect(m.StandardSelecttValidator).toBeDefined();
  });

  it('honours an affix, including on the Standard wrapper', async () => {
    // Per mode, not one flat string: a single prefix resolves all three modes to the same
    // identifier, which `validateAffix` in the CLI refuses before anything is written.
    const m = await emit(analysisOf([table('t', [col('n')])]), {
      affix: {
        schema: { prefix: { insert: 'New', update: 'Patch', select: 'Row' } },
        tableCase: 'pascal',
      },
    });
    expect(m.RowTSchema).toBeDefined();
    expect(m.StandardRowTSchema).toBeDefined();
    expect(m.StandardNewTSchema).toBeDefined();
    expect(m.StandardPatchTSchema).toBeDefined();
  });

  it('honours a file suffix, and the barrel follows it', async () => {
    const dir = await scratch();
    await new EffectGenerator(analysisOf([table('t', [col('n')])])).generate({
      outDir: dir,
      fileSuffix: '.eff.ts',
    } as never);
    expect(await fs.readFile(path.join(dir, 'index.ts'), 'utf8')).toContain("'./t.eff.js'");
    await fs.access(path.join(dir, 't.eff.ts'));
  });
});

describe('the barrel', () => {
  it('re-exports every table with a .js specifier by default', async () => {
    const dir = await scratch();
    const files = await new EffectGenerator(
      analysisOf([table('a', [col('n')]), table('b', [col('n')])])
    ).generate({ outDir: dir } as never);
    expect(files.length).toBe(3);
    const barrel = await fs.readFile(path.join(dir, 'index.ts'), 'utf8');
    expect(barrel).toContain("export * from './a.effect.js';");
    expect(barrel).toContain("export * from './b.effect.js';");
  });

  it("drops the extension under importExtension: 'none'", async () => {
    const dir = await scratch();
    await new EffectGenerator(analysisOf([table('a', [col('n')])])).generate({
      outDir: dir,
      importExtension: 'none',
    } as never);
    expect(await fs.readFile(path.join(dir, 'index.ts'), 'utf8')).toContain("'./a.effect';");
  });
});

describe('duplicateFinder', () => {
  it('is absent by default and emitted on request', async () => {
    const analysis = analysisOf([
      table('t', [col('email')], { unique: [{ columns: ['email'] }] } as never),
    ]);
    expect(await emitText(analysis)).not.toContain('findDuplicatet');
    const m = await emit(analysis, { duplicateFinder: true });
    expect(typeof m.findDuplicatet).toBe('function');
    const dup = (m.findDuplicatet as (rows: unknown[]) => unknown)([
      { email: 'a@b.c' },
      { email: 'a@b.c' },
    ]);
    expect(dup).toBeTruthy();
  });
});

describe('the ValidationRenderer interface', () => {
  it('names itself as the effect library', () => {
    expect(new EffectGenerator(analysisOf([])).library).toBe('effect');
  });

  it('renders one table without touching the filesystem', () => {
    // `renderTable` is part of the interface every generator implements and nothing but a test
    // calls it, which is exactly how it rots. It takes a `Table` rather than an `Analysis`, so it
    // structurally cannot see relations and emits no nested schemas even when asked.
    const t = table('t', [col('n', { maxLength: 3 })]);
    const code = new EffectGenerator(analysisOf([t])).renderTable(
      t as never,
      {
        nestedSchemas: true,
      } as never
    );
    expect(code).toContain('export const SelecttSchema');
    expect(code).toContain('export const StandardSelecttSchema');
    expect(code).toContain("import * as Schema from 'effect/Schema';");
    expect(code).not.toContain('NestedSelectt');
  });
});

describe('the output header', () => {
  it('is on by default and can be turned off', async () => {
    const analysis = analysisOf([table('t', [col('n')])]);
    expect(await emitText(analysis)).toContain('Generated by DRZL');
    expect(await emitText(analysis, { outputHeader: { enabled: false } })).not.toContain(
      'Generated by DRZL'
    );
  });
});
